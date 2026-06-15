// dedupe.js — the librarian frowns at two copies of the same book.

/**
 * Normalise a URL for duplicate comparison.
 * @param {string} url
 * @param {{ignoreFragment?: boolean, ignoreQuery?: boolean}} opts
 */
export function normalizeUrl(url, { ignoreFragment = true, ignoreQuery = false } = {}) {
  try {
    const u = new URL(url);
    if (ignoreFragment) u.hash = "";
    if (ignoreQuery) u.search = "";
    // Trailing slash on the root path is noise.
    let s = u.toString();
    if (u.pathname === "/" && !u.search && !u.hash) s = s.replace(/\/$/, "");
    return s;
  } catch {
    return url;
  }
}

/**
 * Find duplicate tabs.
 * @param {chrome.tabs.Tab[]} tabs
 * @param {object} opts passed to normalizeUrl
 * @returns {Array<{key: string, tabs: chrome.tabs.Tab[]}>} groups of 2+ duplicates,
 *   each group keeping the tabs sorted so the oldest (lowest id) is first = the
 *   "original" to keep.
 */
export function findDuplicates(tabs, opts = {}) {
  const byKey = new Map();
  for (const tab of tabs) {
    if (!tab.url) continue;
    const key = normalizeUrl(tab.url, opts);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tab);
  }
  const groups = [];
  for (const [key, group] of byKey) {
    if (group.length > 1) {
      group.sort((a, b) => a.id - b.id);
      groups.push({ key, tabs: group });
    }
  }
  return groups;
}

/** Total count of *redundant* tabs (duplicates minus one original per group). */
export function duplicateCount(groups) {
  return groups.reduce((n, g) => n + (g.tabs.length - 1), 0);
}
