// dedupe.js — the librarian frowns at two copies of the same book.

/**
 * Map a settings object onto the option shape normalizeUrl/findDuplicates expect.
 * Keeps the settings-key -> option-key translation in one place.
 *
 * `strict` is for the one caller that closes tabs by itself, with nobody looking:
 * only an exact URL match counts. The badge and the "Close duplicates" button use
 * the user's own loose settings — there a human sees the list and decides. So the
 * badge saying "1" while auto-close stays quiet is the intended behaviour.
 * @param {{dedupeIgnoreFragment?: boolean, dedupeIgnoreQuery?: boolean}} settings
 * @param {{strict?: boolean}} opts
 */
export function dedupeOptions(settings, { strict = false } = {}) {
  if (strict) return { ignoreFragment: false, ignoreQuery: false };
  return {
    ignoreFragment: settings.dedupeIgnoreFragment,
    ignoreQuery: settings.dedupeIgnoreQuery,
  };
}

/**
 * Normalise a URL for duplicate comparison.
 * @param {string} url
 * @param {{ignoreFragment?: boolean, ignoreQuery?: boolean}} opts
 */
export function normalizeUrl(url, { ignoreFragment = true, ignoreQuery = false } = {}) {
  try {
    const u = new URL(url);
    // "#/inbox" and "#!/orders" are *routes*, not anchors. Dropping them makes two
    // different pages of a hash-routed app look like the same tab — and the tab
    // you just opened gets closed under you.
    if (ignoreFragment && !/^#!?\//.test(u.hash)) u.hash = "";
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
    // Only real pages. Two chrome://newtab are not "duplicates" the user wants
    // closed. Guarding here covers the badge, auto-close and the button at once.
    if (!/^https?:/i.test(tab.url)) continue;
    const key = normalizeUrl(tab.url, opts);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tab);
  }
  const groups = [];
  for (const [key, group] of byKey) {
    if (group.length > 1) {
      // Pinned first, then oldest. Whatever ends up at index 0 is the keeper, and a
      // pinned tab is the one thing that must never be the one thrown away.
      group.sort((a, b) => (b.pinned === true) - (a.pinned === true) || a.id - b.id);
      groups.push({ key, tabs: group });
    }
  }
  return groups;
}

/**
 * The tabs a "close duplicates" would actually close: everything after the keeper in
 * each group, minus pinned tabs. shelf never closes what you pinned — so the badge
 * counts these, not raw group sizes, and never sits on a number nothing can clear.
 */
export function redundantTabs(groups) {
  return groups.flatMap((g) => g.tabs.slice(1).filter((t) => !t.pinned));
}

/** Total count of *redundant* tabs (duplicates minus one keeper per group). */
export function duplicateCount(groups) {
  return redundantTabs(groups).length;
}
