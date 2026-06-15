// background.js — the librarian on duty. Ephemeral service worker: reacts to tab
// events, reads settings from storage each time, never trusts in-memory state.

import { getSettings } from "./lib/storage.js";
import {
  computeAssignments,
  applyAssignments,
  applyFocusMode,
  setAllCollapsed,
  ungroupAll,
} from "./lib/grouping.js";
import { findDuplicates, duplicateCount, normalizeUrl } from "./lib/dedupe.js";

// --- helpers ---------------------------------------------------------------

async function resolveWindowId(maybeId) {
  if (typeof maybeId === "number") return maybeId;
  const w = await chrome.windows.getLastFocused();
  return w.id;
}

/** Gather the shelvable tabs of a window (pinned tabs can't be grouped by the browser). */
async function shelvableTabs(windowId) {
  return chrome.tabs.query({ windowId, pinned: false });
}

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

/** Shelve every tab in a window, then (in Focus Mode) collapse the lot so one
 *  "Shelve now" both sorts and tidies. */
async function shelveWindow(windowId) {
  const settings = await getSettings();
  const tabs = await shelvableTabs(windowId);
  const assignments = await computeAssignments(tabs, settings);
  await enqueue(windowId, () => applyAssignments(windowId, assignments, settings));
  if (settings.autoCollapse) await enqueue(windowId, () => setAllCollapsed(windowId, true));
  scheduleBadge(windowId);
}

/** On a freshly-loaded tab: only close it if it duplicates an open one. We do NOT
 *  group here — grouping a tab moves it into its group, which would yank the tab
 *  you're looking at down to a faraway shelf. Grouping happens when you leave the
 *  tab (see onActivated). */
async function dedupeCheck(tab) {
  if (tab.pinned || !tab.url) return;
  const settings = await getSettings();
  if (settings.enabled && settings.dedupeAutoClose) await closeIfDuplicate(tab, settings);
  scheduleBadge(tab.windowId);
}

/** Group a single tab — called once the user has navigated away from it, so the
 *  move doesn't disrupt where they are. */
async function groupTab(tab) {
  if (!tab || tab.pinned || !tab.url) return;
  const settings = await getSettings();
  if (!settings.enabled) return;
  const assignments = await computeAssignments([tab], settings);
  if (assignments.size) {
    await enqueue(tab.windowId, () => applyAssignments(tab.windowId, assignments, settings));
  }
  scheduleBadge(tab.windowId);
}

/** If this tab duplicates an older one, close it and focus the original. */
async function closeIfDuplicate(tab, settings) {
  const opts = {
    ignoreFragment: settings.dedupeIgnoreFragment,
    ignoreQuery: settings.dedupeIgnoreQuery,
  };
  const key = normalizeUrl(tab.url, opts);
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const original = tabs.find(
    (t) => t.id !== tab.id && t.url && normalizeUrl(t.url, opts) === key && t.id < tab.id
  );
  if (!original) return false;
  try {
    await chrome.tabs.update(original.id, { active: true });
    await chrome.tabs.remove(tab.id);
    return true;
  } catch {
    return false;
  }
}

/** Update the toolbar badge with the count of redundant duplicate tabs. */
async function refreshBadge(windowId) {
  try {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({ windowId });
    const groups = findDuplicates(tabs, {
      ignoreFragment: settings.dedupeIgnoreFragment,
      ignoreQuery: settings.dedupeIgnoreQuery,
    });
    const n = duplicateCount(groups);
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#a1662f" }); // leather brown
  } catch {
    /* ignore */
  }
}

// --- event wiring ----------------------------------------------------------

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Only the final "complete" event. We dedupe here but do NOT group — grouping
  // waits until the user leaves the tab (onActivated) so it never jumps away.
  if (changeInfo.status === "complete") dedupeCheck(tab);
});

chrome.tabs.onRemoved.addListener((_tabId, info) => {
  if (!info.isWindowClosing) scheduleBadge(info.windowId);
});

// Track the active tab per window, so we can shelve a tab only once the user
// leaves it — never the tab they're currently reading.
const lastActiveByWindow = new Map();

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const prev = lastActiveByWindow.get(windowId);
  lastActiveByWindow.set(windowId, tabId);

  const settings = await getSettings();

  // Shelve the tab we just left — now it can slot into its group without yanking
  // the user anywhere.
  if (settings.enabled && prev != null && prev !== tabId) {
    try {
      await groupTab(await chrome.tabs.get(prev));
    } catch {
      /* the tab we left is already gone */
    }
  }

  // Focus Mode: collapse the other groups around the tab you just moved to.
  if (settings.autoCollapse) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await applyFocusMode(windowId, tab.groupId);
    } catch {
      /* tab gone */
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const windowId = await resolveWindowId();
  if (command === "shelve-now") await shelveWindow(windowId);
  else if (command === "hush") await setAllCollapsed(windowId, true);
});

// --- messages from popup / options ----------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const windowId = await resolveWindowId(msg.windowId);
    switch (msg.type) {
      case "SHELVE_NOW":
        await shelveWindow(windowId);
        return sendResponse({ ok: true });
      case "UNGROUP_ALL":
        await ungroupAll(windowId);
        await refreshBadge(windowId);
        return sendResponse({ ok: true });
      case "HUSH":
        await setAllCollapsed(windowId, true);
        return sendResponse({ ok: true });
      case "EXPAND_ALL":
        await setAllCollapsed(windowId, false);
        return sendResponse({ ok: true });
      case "GET_DUPLICATES": {
        const settings = await getSettings();
        const tabs = await chrome.tabs.query({ windowId });
        const groups = findDuplicates(tabs, {
          ignoreFragment: settings.dedupeIgnoreFragment,
          ignoreQuery: settings.dedupeIgnoreQuery,
        }).map((g) => ({
          key: g.key,
          tabs: g.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
        }));
        return sendResponse({ ok: true, groups });
      }
      case "CLOSE_DUPLICATES": {
        const settings = await getSettings();
        const tabs = await chrome.tabs.query({ windowId });
        const groups = findDuplicates(tabs, {
          ignoreFragment: settings.dedupeIgnoreFragment,
          ignoreQuery: settings.dedupeIgnoreQuery,
        });
        const toClose = groups.flatMap((g) => g.tabs.slice(1).map((t) => t.id)); // keep oldest
        if (toClose.length) await chrome.tabs.remove(toClose);
        await refreshBadge(windowId);
        return sendResponse({ ok: true, closed: toClose.length });
      }
      default:
        return sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // keep the message channel open for the async response
});

// First install: shelve whatever is already open, so the librarian earns his keep.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const windows = await chrome.windows.getAll();
    for (const w of windows) await shelveWindow(w.id);
  } catch {
    /* ignore */
  }
});
