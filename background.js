// background.js — the librarian on duty. Ephemeral service worker: reacts to tab
// events, reads settings from storage each time, never trusts in-memory state.

import { getSettings, setSettings } from "./lib/storage.js";
import {
  assignAll,
  applyAssignments,
  planShelves,
  tidyLoose,
  applyFocusMode,
  setAllCollapsed,
  ungroupAll,
} from "./lib/grouping.js";
import {
  findDuplicates,
  duplicateCount,
  redundantTabs,
  normalizeUrl,
  dedupeOptions,
} from "./lib/dedupe.js";
import { rememberClosed, rememberUngrouped, recall, undo } from "./lib/undo.js";
import { isExcepted } from "./lib/domain.js";

const DISCARD_ALARM = "shelf:discard";

// --- helpers ---------------------------------------------------------------

async function resolveWindowId(maybeId) {
  if (typeof maybeId === "number") return maybeId;
  const w = await chrome.windows.getLastFocused();
  return w.id;
}

/** Is the librarian on duty? Off means switched off; paused means "not for the
 *  next hour", which is what you want when you're mid-task and don't want tabs
 *  moving under you. */
const onDuty = (settings) => settings.enabled && Date.now() >= (settings.pausedUntil || 0);

// --- serialization + debounce ----------------------------------------------

// Shelving must be serialized per window. Two parallel applyAssignments() calls
// would both query an empty group list and each create a duplicate "Github"
// group. A per-window promise chain forces them to run one after another, so the
// second call's tabGroups.query() already sees the group the first one created.
const queues = new Map();
function enqueue(windowId, fn) {
  const prev = queues.get(windowId) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.warn("shelf:", e?.message));
  queues.set(windowId, next);
  return next;
}

/** Test seam: resolves once everything currently queued has settled. */
export const idle = () => Promise.all([...queues.values()]);

// Badge recomputation is debounced per window — onUpdated/onRemoved fire in
// bursts, and recomputing duplicates on every one is wasteful.
const badgeTimers = new Map();
function scheduleBadge(windowId, delay = 300) {
  clearTimeout(badgeTimers.get(windowId));
  badgeTimers.set(
    windowId,
    setTimeout(() => {
      badgeTimers.delete(windowId);
      refreshBadge(windowId);
    }, delay)
  );
}

// --- core actions ----------------------------------------------------------

/**
 * Shelve a window's loose tabs. Read, compute and mutate all happen *inside* the
 * per-window queue — doing the query outside it meant acting on a snapshot that
 * could already be wrong: a tab dragged to another window would get hauled back.
 * @param {number} windowId
 * @param {{only?: Set<number>|null, except?: number|null}} opts
 *   only — move just these tabs; except — move everything but this one.
 */
function shelve(windowId, { only = null, except = null } = {}) {
  return enqueue(windowId, async () => {
    const settings = await getSettings();
    if (!onDuty(settings)) return;
    const tabs = await chrome.tabs.query({ windowId, pinned: false });
    const shelves = await assignAll(tabs, settings);
    const move =
      except == null ? only : new Set(tabs.map((t) => t.id).filter((id) => id !== except));
    await applyAssignments(windowId, shelves, settings, tabs, move);
    // Whatever is still loose goes to the end, so the shelves aren't broken up by
    // strays. Inside the queue, after the grouping, on its own fresh read.
    if (settings.tidyLooseTabs) await tidyLoose(windowId);
  });
}

/** Shelve every loose tab in a window, then (in Focus Mode) collapse the lot so one
 *  "Shelve now" both sorts and tidies. */
async function shelveWindow(windowId) {
  await shelve(windowId);
  const settings = await getSettings();
  if (settings.autoCollapse) await enqueue(windowId, () => setAllCollapsed(windowId, true));
  scheduleBadge(windowId);
}

/** On a freshly-loaded tab: only close it if it duplicates an open one. We do NOT
 *  group here — grouping a tab moves it into its group, which would yank the tab
 *  you're looking at down to a faraway shelf. Grouping happens when you leave the
 *  tab (see onActivated). */
async function dedupeCheck(tab) {
  if (!tab.url) return;
  if (!tab.pinned && /^https?:/i.test(tab.url)) {
    const settings = await getSettings();
    if (onDuty(settings) && settings.dedupeAutoClose) {
      // Serialize per window so two duplicates opened at once don't race each other.
      await enqueue(tab.windowId, () => closeIfDuplicate(tab, settings));
    }
  }
  scheduleBadge(tab.windowId);
}

/** If this tab duplicates an older one, close it and focus the original. */
async function closeIfDuplicate(tab, settings) {
  // Strict: an exact URL match, whatever the user's looser badge settings say.
  // Nobody is watching this one, and a closed tab does not come back on its own.
  const opts = dedupeOptions(settings, { strict: true });
  const key = normalizeUrl(tab.url, opts);
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const original = tabs.find(
    (t) => t.id !== tab.id && t.url && normalizeUrl(t.url, opts) === key && t.id < tab.id
  );
  if (!original) return false;
  try {
    await chrome.tabs.update(original.id, { active: true });
    await chrome.tabs.remove(tab.id);
    await rememberClosed([tab], { kind: "auto-close" });
    return true;
  } catch {
    return false;
  }
}

/** The one place that asks "what's duplicated in this window?" */
async function duplicatesIn(windowId, settings) {
  const s = settings || (await getSettings());
  const tabs = await chrome.tabs.query({ windowId });
  const groups = findDuplicates(tabs, dedupeOptions(s));
  return { groups, count: duplicateCount(groups) };
}

/** Update the toolbar badge with the count of redundant duplicate tabs.
 *  chrome.action has no per-window badge text, so only the focused window may write
 *  it — otherwise a background window's count sits on the icon you're looking at. */
async function refreshBadge(windowId) {
  try {
    const focused = await chrome.windows.getLastFocused();
    if (focused.id !== windowId) return;
    const { count } = await duplicatesIn(windowId);
    await chrome.action.setBadgeText({ text: count ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#a1662f" }); // leather brown
  } catch {
    /* ignore */
  }
}

/**
 * Unload the tabs sitting in collapsed shelves — a shelf you've folded shut is one
 * you aren't reading, and Chrome will happily hold its memory anyway.
 *
 * Stateless on purpose: it reads the live window state rather than trusting
 * anything the worker remembered, because the worker may have died since the alarm
 * was set. Nothing here is persisted.
 */
async function discardCollapsed() {
  const settings = await getSettings();
  if (!settings.discardOnCollapse) return;
  const exceptions = new Set(settings.exceptions);

  for (const w of await chrome.windows.getAll()) {
    const collapsed = (await chrome.tabGroups.query({ windowId: w.id })).filter(
      (g) => g.collapsed
    );
    if (!collapsed.length) continue;
    const ids = new Set(collapsed.map((g) => g.id));

    for (const t of await chrome.tabs.query({ windowId: w.id })) {
      if (!ids.has(t.groupId)) continue;
      // Never take away something you're using, listening to, still loading, or
      // told us to leave alone.
      if (t.active || t.pinned || t.audible || t.discarded) continue;
      if (t.status !== "complete") continue;
      if (!/^https?:/i.test(t.url || "")) continue;
      if (isExcepted(t.url, exceptions)) continue;
      try {
        await chrome.tabs.discard(t.id);
      } catch {
        // Chrome refuses on tabs it considers busy. Its call, not ours.
      }
    }
  }
}

// --- event wiring ----------------------------------------------------------

// Someone folded a shelf shut — us, or the user by hand. Either way, start the
// clock. chrome.alarms rather than setTimeout: this worker will very likely be
// dead by the time it fires.
chrome.tabGroups.onUpdated.addListener(async (group) => {
  if (!group.collapsed) return;
  const settings = await getSettings();
  if (!settings.discardOnCollapse) return;
  await chrome.alarms.create(DISCARD_ALARM, {
    delayInMinutes: Math.max(1, settings.discardDelayMin),
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DISCARD_ALARM) return discardCollapsed();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Only the final "complete" event. We dedupe here but do NOT group — grouping
  // waits until the user leaves the tab (onActivated) so it never jumps away.
  // Returning the promise is ignored by Chrome and lets tests await the work.
  if (changeInfo.status === "complete") return dedupeCheck(tab);
});

chrome.tabs.onRemoved.addListener((_tabId, info) => {
  if (!info.isWindowClosing) scheduleBadge(info.windowId);
});

// Dragged into another window: it arrives loose, and the window it left has one
// less tab to count.
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  scheduleBadge(newWindowId);
  return shelve(newWindowId, { only: new Set([tabId]) });
});
chrome.tabs.onDetached.addListener((_tabId, { oldWindowId }) => {
  scheduleBadge(oldWindowId);
});

// The badge belongs to whichever window you're looking at.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduleBadge(windowId, 0);
});

// Track the active tab per window, so we can shelve a tab only once the user
// leaves it — never the tab they're currently reading.
const lastActiveByWindow = new Map();

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const prev = lastActiveByWindow.get(windowId);
  lastActiveByWindow.set(windowId, tabId);

  const settings = await getSettings();

  if (onDuty(settings)) {
    if (prev != null && prev !== tabId) {
      // Normal path: shelve the tab we just left — now it can slot into its group
      // without yanking the user anywhere.
      await shelve(windowId, { only: new Set([prev]) });
    } else if (prev == null) {
      // The service worker just woke up (its in-memory map was wiped after idle).
      // Catch up on whatever piled up while it slept — in one pass. The old per-tab
      // loop cost a storage read and a group query each, and grouped nothing.
      await shelve(windowId, { except: tabId });
    }
  }

  // Focus Mode: collapse the other groups around the tab you just moved to.
  if (settings.autoCollapse && onDuty(settings)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await applyFocusMode(windowId, tab.groupId);
    } catch {
      /* tab gone */
    }
  }
});

// Window closed — drop its per-window state so the maps never grow unbounded and
// no stale badge timer fires on a dead window.
chrome.windows.onRemoved.addListener((windowId) => {
  clearTimeout(badgeTimers.get(windowId));
  badgeTimers.delete(windowId);
  queues.delete(windowId);
  lastActiveByWindow.delete(windowId);
});

chrome.commands.onCommand.addListener(async (command) => {
  const windowId = await resolveWindowId();
  if (command === "shelve-now") await shelveWindow(windowId);
  else if (command === "hush") await setAllCollapsed(windowId, true);
});

// --- messages from popup / options ----------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // The popup awaits this response and has no timeout: if we throw before
    // answering, the channel closes and its buttons silently stop working. So every
    // path answers, including the failures.
    try {
      const windowId = await resolveWindowId(msg.windowId);
      switch (msg.type) {
        case "SHELVE_NOW":
          await shelveWindow(windowId);
          return sendResponse({ ok: true });
        case "UNGROUP_ALL": {
          const moved = await ungroupAll(windowId);
          await rememberUngrouped(windowId, moved);
          await refreshBadge(windowId);
          return sendResponse({ ok: true });
        }
        case "PREVIEW": {
          // What shelving would do, without doing it. Same planner the real thing
          // uses, so the first-run screen can't promise something else.
          const settings = await getSettings();
          const shelves = [];
          let loose = 0;
          for (const w of await chrome.windows.getAll()) {
            const tabs = await chrome.tabs.query({ windowId: w.id, pinned: false });
            loose += tabs.filter((t) => (t.groupId ?? -1) === -1).length;
            const existing = await chrome.tabGroups.query({ windowId: w.id });
            const plan = planShelves(await assignAll(tabs, settings), settings, tabs, existing);
            for (const step of plan) {
              shelves.push({
                title: step.title,
                color: step.color,
                count: step.tabIds.length,
                joining: step.groupId !== undefined,
              });
            }
          }
          return sendResponse({ ok: true, loose, shelves });
        }
        case "SHELVE_ALL_WINDOWS": {
          for (const w of await chrome.windows.getAll()) await shelveWindow(w.id);
          return sendResponse({ ok: true });
        }
        case "PAUSE": {
          const minutes = Math.min(600, Math.max(1, Number(msg.minutes) || 60));
          await setSettings({ pausedUntil: Date.now() + minutes * 60_000 });
          return sendResponse({ ok: true, minutes });
        }
        case "RESUME":
          await setSettings({ pausedUntil: 0 });
          return sendResponse({ ok: true });
        case "GET_STATE": {
          const s = await getSettings();
          return sendResponse({ ok: true, pausedUntil: s.pausedUntil, enabled: s.enabled });
        }
        case "GET_UNDO": {
          const action = await recall();
          return sendResponse({
            ok: true,
            action: action ? { label: action.label, at: action.at } : null,
          });
        }
        case "UNDO": {
          const res = await undo();
          await refreshBadge(windowId);
          return sendResponse({ ok: true, ...res });
        }
        case "HUSH":
          await setAllCollapsed(windowId, true);
          return sendResponse({ ok: true });
        case "EXPAND_ALL":
          await setAllCollapsed(windowId, false);
          return sendResponse({ ok: true });
        case "GET_DUPLICATES": {
          const { groups } = await duplicatesIn(windowId);
          return sendResponse({
            ok: true,
            groups: groups.map((g) => ({
              key: g.key,
              tabs: g.tabs.map((t) => ({
                id: t.id,
                title: t.title,
                url: t.url,
                favIconUrl: t.favIconUrl,
                pinned: t.pinned,
              })),
            })),
          });
        }
        case "CLOSE_DUPLICATES": {
          const { groups } = await duplicatesIn(windowId);
          const doomed = redundantTabs(groups);
          // A single id can go stale between the query and the removal, and a batch
          // remove() rejects the whole call for it — closing nothing at all.
          const results = await Promise.allSettled(
            doomed.map((t) => chrome.tabs.remove(t.id))
          );
          const gone = doomed.filter((_, i) => results[i].status === "fulfilled");
          await rememberClosed(gone, { kind: "close-dupes" });
          await refreshBadge(windowId);
          return sendResponse({ ok: true, closed: gone.length });
        }
        default:
          return sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      return sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep the message channel open for the async response
});

// First install: touch nothing. Show the user what shelving *would* do and let them
// say yes. Silently rearranging the forty-seven tabs someone has been keeping in a
// particular order is how an extension gets uninstalled in its first minute.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html?first-run") });
  } catch {
    /* ignore */
  }
});
