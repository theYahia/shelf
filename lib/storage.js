// storage.js — the librarian's ledger.
// MV3 service workers are ephemeral: they get killed between events, so nothing
// lives in memory. Every setting is read from storage on demand.
//
// local, not sync. shelf promises "no cloud", and chrome.storage.sync is exactly
// that — your rules ride Google's servers under the browser account, including the
// internal hostnames you put in them. It also caps a single item at 8 KB, which a
// long rules list can reach. Moving settings between machines is what the options
// page's Export / Import is for.

import { GROUP_COLORS } from "./domain.js";

export const SCHEMA_VERSION = 2;

export const DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  enabled: true, // master switch for automatic shelving of new tabs
  autoCollapse: true, // Focus Mode: collapse every group except the active one
  mergeSubdomains: true, // mail.example.com + www.example.com -> "example.com"
  minTabsToGroup: 2, // don't shelve lone tabs — only group a site with 2+ open
  tidyLooseTabs: true, // sweep whatever stays loose to the end, so shelves sit together
  collapseThreshold: 0, // collapse any group larger than N tabs (0 = off)
  exceptions: [], // domains the librarian never touches, e.g. ["localhost"]
  rules: [], // [{ match: "github.com", name: "Code", color: "blue" }] — override domain
  dedupeAutoClose: true, // auto-close a tab that duplicates an existing one
  dedupeIgnoreFragment: true, // treat a#b and a#c as duplicates (never a#/b and a#/c)
  dedupeIgnoreQuery: false, // treat a?x=1 and a?x=2 as duplicates
  pausedUntil: 0, // epoch ms; until then shelf keeps its hands off
  discardOnCollapse: false, // unload a shelf's tabs once it's collapsed (opt-in)
  discardDelayMin: 1, // …after this many minutes collapsed
};

const bool = (v, d) => (typeof v === "boolean" ? v : d);
const int = (v, d, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/**
 * Force a stored blob into the shape the rest of the code assumes.
 *
 * This is the one gate, and it earns its keep: a `rules` that wasn't an array used
 * to throw inside matchRule, get swallowed by the queue's catch, and silently kill
 * grouping until the user cleared storage by hand. It's also the validator for
 * imported JSON — same untrusted input, same door.
 */
export function sanitize(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: bool(s.enabled, DEFAULTS.enabled),
    autoCollapse: bool(s.autoCollapse, DEFAULTS.autoCollapse),
    mergeSubdomains: bool(s.mergeSubdomains, DEFAULTS.mergeSubdomains),
    tidyLooseTabs: bool(s.tidyLooseTabs, DEFAULTS.tidyLooseTabs),
    dedupeAutoClose: bool(s.dedupeAutoClose, DEFAULTS.dedupeAutoClose),
    dedupeIgnoreFragment: bool(s.dedupeIgnoreFragment, DEFAULTS.dedupeIgnoreFragment),
    dedupeIgnoreQuery: bool(s.dedupeIgnoreQuery, DEFAULTS.dedupeIgnoreQuery),
    discardOnCollapse: bool(s.discardOnCollapse, DEFAULTS.discardOnCollapse),
    minTabsToGroup: int(s.minTabsToGroup, DEFAULTS.minTabsToGroup, 1, 20),
    collapseThreshold: int(s.collapseThreshold, DEFAULTS.collapseThreshold, 0, 50),
    discardDelayMin: int(s.discardDelayMin, DEFAULTS.discardDelayMin, 1, 120),
    pausedUntil: int(s.pausedUntil, 0, 0, Number.MAX_SAFE_INTEGER),
    exceptions: Array.isArray(s.exceptions)
      ? [
          ...new Set(
            s.exceptions.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
          ),
        ]
      : [],
    rules: Array.isArray(s.rules)
      ? s.rules
          .filter((r) => r && typeof r === "object")
          .map((r) => ({
            match: String(r.match ?? "").trim(),
            name: String(r.name ?? "").trim(),
            color: GROUP_COLORS.includes(r.color) ? r.color : "blue",
          }))
          .filter((r) => r.match && r.name)
      : [],
  };
}

/**
 * v1 had no schemaVersion and lived in chrome.storage.sync. Move it across once,
 * then stamp the version so this never runs again. The old sync copy is left where
 * it is for a couple of releases — downgrading should not cost anyone their rules.
 */
async function migrate(local) {
  let raw = local;
  if (!local || Object.keys(local).length === 0) {
    try {
      const synced = await chrome.storage.sync.get(null);
      if (synced && Object.keys(synced).length) raw = synced;
    } catch {
      /* no sync area — start from defaults */
    }
  }
  const settings = sanitize(raw);
  try {
    await chrome.storage.local.set(settings);
  } catch {
    /* write refused — the settings are still usable for this session */
  }
  return settings;
}

/** Read the full settings object. Always returns something safe to use. */
export async function getSettings() {
  let stored;
  try {
    stored = await chrome.storage.local.get(null);
  } catch {
    return sanitize(null); // storage unavailable: defaults beat a dead worker
  }
  if (stored && stored.schemaVersion === SCHEMA_VERSION) return sanitize(stored);
  return migrate(stored);
}

/**
 * Merge a partial patch into stored settings and return the result.
 * Rejects if the write is refused — the options page reports that, instead of a
 * tick that quietly never appears.
 */
export async function setSettings(patch) {
  const next = sanitize({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set(next);
  return next;
}
