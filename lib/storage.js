// storage.js — the librarian's ledger.
// MV3 service workers are ephemeral: they get killed between events, so nothing
// lives in memory. Every setting is read from chrome.storage.sync on demand.

export const DEFAULTS = {
  enabled: true, // master switch for automatic shelving of new tabs
  autoCollapse: true, // Focus Mode: collapse every group except the active one
  mergeSubdomains: true, // mail.example.com + www.example.com -> "example.com"
  minTabsToGroup: 1, // do not create a group for fewer than N tabs of a domain
  collapseThreshold: 0, // collapse any group larger than N tabs (0 = off)
  exceptions: [], // domains the librarian never touches, e.g. ["localhost"]
  rules: [], // [{ match: "github.com", name: "Code", color: "blue" }] — override domain
  dedupeAutoClose: false, // auto-close a tab that duplicates an existing one
  dedupeIgnoreFragment: true, // treat a#b and a#c as duplicates
  dedupeIgnoreQuery: false, // treat a?x=1 and a?x=2 as duplicates
};

/** Read the full settings object, filling any missing key with its default. */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/** Merge a partial patch into stored settings. */
export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

/** Subscribe to settings changes (sync area only). Returns an unsubscribe fn. */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === "sync") callback(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
