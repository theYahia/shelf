// grouping.js — the shelving engine.
//
// A GroupingStrategy looks at a set of tabs and decides which shelf (group title +
// colour) each one belongs on. v1 ships two strategies; the pipeline runs them in
// order and the first one to claim a tab wins. This is the provider-hook for v2:
// dropping an OllamaStrategy into PIPELINE adds semantic grouping with zero changes
// to the engine below.

import { getDomain, domainToColor, domainToTitle, GROUP_COLORS } from "./domain.js";

const TAB_GROUP_ID_NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

/** @typedef {{key: string, title: string, color: string, autoColor?: boolean}} Shelf */

/** Base class. A strategy returns Map<tabId, Shelf> for the tabs it claims. */
export class GroupingStrategy {
  /** @returns {Promise<Map<number, Shelf>>} */
  async assign(_tabs, _settings) {
    throw new Error("GroupingStrategy.assign not implemented");
  }
}

/** Match a tab's URL against a user rule (domain, subdomain, or substring). Exported for tests. */
export function matchRule(url, rules) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  for (const r of rules) {
    if (!r.match) continue;
    const m = r.match.toLowerCase();
    if (host === m || host.endsWith("." + m) || host.includes(m) || url.includes(m)) {
      return r;
    }
  }
  return null;
}

/** User rules: an explicit {match,name,color} overrides automatic domain grouping. */
export class RulesStrategy extends GroupingStrategy {
  async assign(tabs, settings) {
    const out = new Map();
    for (const tab of tabs) {
      if (!tab.url) continue;
      const rule = matchRule(tab.url, settings.rules || []);
      if (rule && rule.name) {
        out.set(tab.id, {
          key: "rule:" + rule.name,
          title: rule.name,
          color: rule.color || domainToColor(rule.name),
          autoColor: !rule.color, // honour an explicit rule colour; otherwise rotate
        });
      }
    }
    return out;
  }
}

/** Automatic grouping by domain — the default cataloguing system. */
export class DomainStrategy extends GroupingStrategy {
  async assign(tabs, settings) {
    const out = new Map();
    const exceptions = new Set((settings.exceptions || []).map((d) => d.toLowerCase()));
    for (const tab of tabs) {
      if (!tab.url) continue;
      const domain = getDomain(tab.url, { mergeSubdomains: settings.mergeSubdomains });
      if (!domain) continue; // internal/special pages
      if (exceptions.has(domain.toLowerCase())) continue; // never touch these
      out.set(tab.id, {
        key: domain,
        title: domainToTitle(domain),
        color: domainToColor(domain),
        autoColor: true, // colour is assigned by rotation so neighbours never clash
      });
    }
    return out;
  }
}

// The pipeline. Rules win over domain. v2: PIPELINE.unshift(new OllamaStrategy()).
const PIPELINE = [new RulesStrategy(), new DomainStrategy()];

/**
 * Run the pipeline; first strategy to claim a tab wins. -> Map<tabId, Shelf>
 * Only *loose* tabs (not already in a group) are shelved — tabs the user grouped
 * by hand are left exactly where they are.
 */
export async function computeAssignments(tabs, settings) {
  const loose = tabs.filter((t) => t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE);
  const claimed = new Map();
  for (const strategy of PIPELINE) {
    const result = await strategy.assign(loose, settings);
    for (const [tabId, shelf] of result) {
      if (!claimed.has(tabId)) claimed.set(tabId, shelf);
    }
  }
  return claimed;
}

/**
 * Physically shelve the tabs: create/reuse groups by title, paint them, collapse
 * the big ones. Reuses an existing same-titled group in the window when present.
 */
export async function applyAssignments(windowId, assignments, settings) {
  const byTitle = new Map(); // title -> { color, autoColor, tabIds: [] }
  for (const [tabId, shelf] of assignments) {
    if (!byTitle.has(shelf.title)) {
      byTitle.set(shelf.title, { color: shelf.color, autoColor: shelf.autoColor, tabIds: [] });
    }
    byTitle.get(shelf.title).tabIds.push(tabId);
  }

  const existing = await chrome.tabGroups.query({ windowId });
  const titleToGroupId = new Map(existing.map((g) => [g.title, g.id]));

  // The browser only has 8 group colours, so reuse across many groups is
  // unavoidable — but we rotate through the palette by creation order so that
  // *adjacent* groups never share a colour and visually run together. Seed the
  // rotation past the groups that already exist.
  let colorTick = existing.length;

  for (const [title, { color, autoColor, tabIds }] of byTitle) {
    let groupId = titleToGroupId.get(title);
    // Only gate the *creation* of a new group by minTabsToGroup; always allow
    // joining an existing shelf.
    if (groupId === undefined && tabIds.length < (settings.minTabsToGroup || 1)) continue;

    const collapsed =
      settings.collapseThreshold > 0 && tabIds.length > settings.collapseThreshold;
    try {
      if (groupId === undefined) {
        groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        const paint = autoColor ? GROUP_COLORS[colorTick % GROUP_COLORS.length] : color;
        colorTick++;
        await chrome.tabGroups.update(groupId, { title, color: paint, collapsed });
      } else {
        // Existing shelf: add the tabs, but never rename or re-collapse it —
        // respect whatever the user set by hand (a manual rename, colour, or
        // collapse). Collapse state is managed separately by Focus Mode.
        await chrome.tabs.group({ tabIds, groupId });
      }
    } catch (e) {
      // A tab may have closed mid-shelving, or be pinned. Skip and carry on quietly.
      console.warn("shelf: could not shelve", title, e?.message);
    }
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

/** Tear down every group in the window — back to one long shelf of loose tabs. */
export async function ungroupAll(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const grouped = tabs
    .filter((t) => t.groupId !== TAB_GROUP_ID_NONE && !t.pinned)
    .map((t) => t.id);
  if (!grouped.length) return;
  try {
    await chrome.tabs.ungroup(grouped);
  } catch (e) {
    // Window may have closed between query and ungroup.
    console.warn("shelf: ungroup failed", e?.message);
  }
}
