// grouping.js — the shelving engine.
//
// A strategy is a plain function (tabs, settings) => Map<tabId, Shelf>. The pipeline
// runs them in order and the first one to claim a tab wins. This is the provider-hook
// for v2: dropping an ollamaStrategy into PIPELINE adds semantic grouping with zero
// changes to the engine below.

import { getDomain, domainToColor, domainToTitle, isExcepted } from "./domain.js";

const TAB_GROUP_ID_NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE, inlined so this file runs in node

const isLoose = (t) => t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE;

/** @typedef {{key: string, title: string, color: string}} Shelf */

/** Match a tab's URL against a user rule. Exported for tests. */
export function matchRule(url, rules) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  const lowerUrl = url.toLowerCase();
  for (const r of rules) {
    const m = (r.match || "").trim().toLowerCase();
    if (!m) continue;
    if (m.includes("/")) {
      // A slash means the user is aiming at a path: "github.com/issues".
      if (lowerUrl.includes(m)) return r;
    } else if (m.includes(".")) {
      // A domain: the host itself or a subdomain of it. Never a substring — a rule
      // of "co" used to claim every .com in the browser.
      if (host === m || host.endsWith("." + m)) return r;
    } else if (host.split(".").slice(0, -1).includes(m)) {
      // A bare word matches a whole label: "youtube" -> youtube.com, m.youtube.com.
      // Never the last one, or a rule of "com" would sweep the entire browser onto
      // one shelf — same reason isExcepted() stops before the bare TLD.
      return r;
    }
  }
  return null;
}

/** User rules: an explicit {match,name,color} overrides automatic domain grouping. */
function byRules(tabs, settings) {
  const out = new Map();
  for (const tab of tabs) {
    const rule = matchRule(tab.url, settings.rules || []);
    if (rule && rule.name) {
      out.set(tab.id, {
        key: "rule:" + rule.name,
        title: rule.name,
        color: rule.color || domainToColor(rule.name),
      });
    }
  }
  return out;
}

/** Automatic grouping by domain — the default cataloguing system. */
function byDomain(tabs, settings) {
  const out = new Map();
  for (const tab of tabs) {
    const domain = getDomain(tab.url, { mergeSubdomains: settings.mergeSubdomains });
    if (!domain) continue; // internal/special pages
    out.set(tab.id, { key: domain, title: domainToTitle(domain), color: domainToColor(domain) });
  }
  return out;
}

// The pipeline. Rules win over domain. v2: PIPELINE.unshift(ollamaStrategy).
const PIPELINE = [byRules, byDomain];

/**
 * Run the pipeline over every tab given; first strategy to claim a tab wins.
 * Exceptions are applied here, once, before any strategy runs — otherwise a rule
 * could claim a tab the user explicitly told the librarian to leave alone.
 * @returns {Promise<Map<number, Shelf>>}
 */
export async function assignAll(tabs, settings) {
  const exceptions = new Set(
    (settings.exceptions || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean)
  );
  const eligible = tabs.filter((t) => t.url && !isExcepted(t.url, exceptions));
  const claimed = new Map();
  for (const strategy of PIPELINE) {
    const result = await strategy(eligible, settings);
    for (const [tabId, shelf] of result) {
      if (!claimed.has(tabId)) claimed.set(tabId, shelf);
    }
  }
  return claimed;
}

/**
 * Same pipeline, but only over *loose* tabs — the ones shelf is allowed to move.
 * Tabs the user grouped by hand are left exactly where they are.
 */
export async function computeAssignments(tabs, settings) {
  return assignAll(tabs.filter(isLoose), settings);
}

/**
 * Which existing group holds which shelf? chrome.tabGroups has no room for our own
 * metadata, so we ask the tabs instead: a group whose members mostly belong to one
 * key *is* that key's shelf. No persisted map to go stale, works for groups the user
 * made by hand, survives a browser restart. A mixed hand-made group has no majority
 * and gets no mapping — we don't colonise it.
 * @returns {Map<string, number>} key -> groupId
 */
function indexGroupsByKey(tabs, shelves) {
  const tally = new Map(); // groupId -> Map<key, count>
  for (const t of tabs) {
    if (isLoose(t)) continue;
    const shelf = shelves.get(t.id);
    if (!shelf) continue;
    if (!tally.has(t.groupId)) tally.set(t.groupId, new Map());
    const counts = tally.get(t.groupId);
    counts.set(shelf.key, (counts.get(shelf.key) || 0) + 1);
  }

  const keyToGroupId = new Map();
  for (const [groupId, counts] of tally) {
    let best = null;
    let bestN = 0;
    let tied = false;
    for (const [key, n] of counts) {
      if (n > bestN) {
        best = key;
        bestN = n;
        tied = false;
      } else if (n === bestN) {
        tied = true;
      }
    }
    if (best && !tied && !keyToGroupId.has(best)) keyToGroupId.set(best, groupId);
  }
  return keyToGroupId;
}

/**
 * Work out what shelving would do, without doing any of it. Pure — no chrome.* —
 * which is what lets the first-run screen show the user the plan before anything
 * moves, and lets the whole decision be unit-tested.
 *
 * @param {Map<number, Shelf>} shelves assignments for *every* tab in the window
 * @param {object} settings
 * @param {chrome.tabs.Tab[]} tabs every tab in the window
 * @param {chrome.tabGroups.TabGroup[]} existing the window's current groups
 * @param {Set<number>|null} only restrict the move to these tabs; null = all loose ones
 * @returns {Array<{key, title, color, tabIds, groupId?: number, collapsed: boolean}>}
 *   one step per shelf; `groupId` present means "join that group", absent means "make one"
 */
export function planShelves(shelves, settings, tabs, existing, only = null) {
  // Tabs that belong on each shelf, grouped ones included. The minTabsToGroup gate
  // asks "does this site have N tabs open in this window?", not "did this batch
  // happen to carry N?" — that difference is why a lone new tab never got a shelf.
  const siblings = new Map();
  for (const t of tabs) {
    const shelf = shelves.get(t.id);
    if (shelf) siblings.set(shelf.key, (siblings.get(shelf.key) || 0) + 1);
  }

  // Only loose tabs move, and only the ones this call was asked to handle.
  const buckets = new Map(); // key -> { shelf, tabIds: [] }
  for (const t of tabs) {
    if (!isLoose(t)) continue;
    if (only && !only.has(t.id)) continue;
    const shelf = shelves.get(t.id);
    if (!shelf) continue;
    if (!buckets.has(shelf.key)) buckets.set(shelf.key, { shelf, tabIds: [] });
    buckets.get(shelf.key).tabIds.push(t.id);
  }
  if (!buckets.size) return [];

  const keyToGroupId = indexGroupsByKey(tabs, shelves);
  const claimed = new Set(keyToGroupId.values());
  // Groups whose tabs gave us no key at all (a shelf of chrome:// pages, say) can
  // still be matched by title — it's the only thing we know about them.
  const titleToGroupId = new Map();
  for (const g of existing) {
    if (!claimed.has(g.id) && !titleToGroupId.has(g.title)) titleToGroupId.set(g.title, g.id);
  }
  const usedTitles = new Set(existing.map((g) => g.title));

  const plan = [];
  for (const [key, { shelf, tabIds }] of buckets) {
    let groupId = keyToGroupId.get(key);
    if (groupId === undefined) groupId = titleToGroupId.get(shelf.title);
    // Only gate the *creation* of a new shelf; always allow joining an existing one.
    if (groupId === undefined && (siblings.get(key) || 0) < (settings.minTabsToGroup || 1)) {
      continue;
    }

    let title = shelf.title;
    if (groupId === undefined) {
      // Two different sites can share a title: example.com and example.org are both
      // "Example". Whoever gets there second is named by its full key instead.
      // ponytail: titles are cosmetic, so this is enough. Revisit if users complain.
      if (usedTitles.has(title)) title = key;
      usedTitles.add(title);
    }
    plan.push({
      key,
      title,
      color: shelf.color,
      tabIds,
      groupId,
      collapsed: settings.collapseThreshold > 0 && tabIds.length > settings.collapseThreshold,
    });
  }
  return plan;
}

/**
 * Physically shelve the tabs, following the plan.
 * @param {number} windowId
 * @param {Map<number, Shelf>} shelves assignments for *every* tab in the window
 * @param {object} settings
 * @param {chrome.tabs.Tab[]} tabs every tab in the window (already queried by the caller)
 * @param {Set<number>|null} only restrict the move to these tabs; null = all loose ones
 */
export async function applyAssignments(windowId, shelves, settings, tabs, only = null) {
  const existing = await chrome.tabGroups.query({ windowId });
  for (const step of planShelves(shelves, settings, tabs, existing, only)) {
    try {
      if (step.groupId === undefined) {
        const groupId = await chrome.tabs.group({
          tabIds: step.tabIds,
          createProperties: { windowId },
        });
        await chrome.tabGroups.update(groupId, {
          title: step.title,
          color: step.color,
          collapsed: step.collapsed,
        });
      } else {
        // Existing shelf: add the tabs, but never rename or re-collapse it —
        // respect whatever the user set by hand (a manual rename, colour, or
        // collapse). Collapse state is managed separately by Focus Mode.
        await chrome.tabs.group({ tabIds: step.tabIds, groupId: step.groupId });
      }
    } catch (e) {
      // A tab may have closed mid-shelving, or be pinned. Skip and carry on quietly.
      console.warn("shelf: could not shelve", step.title, e?.message);
    }
  }
}

/**
 * Sweep the strays to the end of the strip, so the shelves stand together instead
 * of being broken up by lone tabs. Their order among themselves is kept.
 *
 * Skips the tab you're on: moving that out from under you is the one thing shelf
 * doesn't do. It gets swept with the rest the moment you leave it.
 */
export async function tidyLoose(windowId) {
  // Re-read: the caller's snapshot was taken before shelving moved anything.
  const tabs = (await chrome.tabs.query({ windowId, pinned: false })).sort(
    (a, b) => a.index - b.index
  );
  const strays = tabs.filter((t) => isLoose(t) && !t.active);
  if (!strays.length) return;

  // Already sitting at the end? Leave the strip alone — a pointless move still
  // makes every tab jump.
  const tail = tabs.slice(tabs.length - strays.length);
  if (tail.length === strays.length && tail.every((t, i) => t.id === strays[i].id)) return;

  try {
    await chrome.tabs.move(strays.map((t) => t.id), { index: -1 });
  } catch (e) {
    // A tab closed mid-sweep, or the window went away.
    console.warn("shelf: could not tidy", e?.message);
  }
}

/** Focus Mode: collapse every group except the one holding the active tab. */
export async function applyFocusMode(windowId, activeGroupId) {
  // Active tab is outside any group — leave the shelves as they are rather than
  // collapsing everything.
  if (activeGroupId === TAB_GROUP_ID_NONE) return;
  const groups = await chrome.tabGroups.query({ windowId });
  for (const g of groups) {
    const shouldCollapse = g.id !== activeGroupId;
    if (g.collapsed !== shouldCollapse) {
      try {
        await chrome.tabGroups.update(g.id, { collapsed: shouldCollapse });
      } catch {
        /* group vanished — ignore */
      }
    }
  }
}

/** Collapse (hush) or expand every group in the window. */
export async function setAllCollapsed(windowId, collapsed) {
  const groups = await chrome.tabGroups.query({ windowId });
  for (const g of groups) {
    try {
      await chrome.tabGroups.update(g.id, { collapsed });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Tear down every group in the window — back to one long shelf of loose tabs.
 * @returns {Promise<Array<{tabId, groupId, index, title, color, collapsed}>>} a
 *   snapshot taken before the teardown, so undo can rebuild the shelves.
 */
export async function ungroupAll(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const grouped = tabs.filter((t) => !isLoose(t) && !t.pinned);
  if (!grouped.length) return [];

  const groups = await chrome.tabGroups.query({ windowId });
  const meta = new Map(groups.map((g) => [g.id, g]));
  const snapshot = grouped.map((t) => {
    const g = meta.get(t.groupId) || {};
    return {
      tabId: t.id,
      groupId: t.groupId,
      index: t.index,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
    };
  });

  try {
    await chrome.tabs.ungroup(grouped.map((t) => t.id));
  } catch (e) {
    // Window may have closed between query and ungroup.
    console.warn("shelf: ungroup failed", e?.message);
    return [];
  }
  return snapshot;
}
