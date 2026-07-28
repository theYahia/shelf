// The ledger: repairing bad input, and the one-time move off chrome.storage.sync.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeWorld, makeChrome } from "./fake-chrome.js";
import { getSettings, setSettings, sanitize, SCHEMA_VERSION } from "../lib/storage.js";

function install(init = {}) {
  const world = makeWorld(init);
  globalThis.chrome = makeChrome(world);
  return world;
}

// --- sanitize -------------------------------------------------------------

test("sanitize: a rules field that isn't a list no longer kills grouping", () => {
  // This used to throw inside matchRule, get swallowed by the queue's catch, and
  // leave shelving silently dead until storage was cleared by hand.
  assert.deepEqual(sanitize({ rules: "nonsense" }).rules, []);
  assert.deepEqual(sanitize({ rules: null }).rules, []);
  assert.deepEqual(sanitize({ exceptions: 42 }).exceptions, []);
  assert.deepEqual(sanitize(null).rules, []);
  assert.deepEqual(sanitize("nonsense").exceptions, []);
});

test("sanitize: half-written rules are dropped, unknown colours fall back", () => {
  const { rules } = sanitize({
    rules: [
      { match: "github.com", name: "Code", color: "blue" },
      { match: "  spaced.com  ", name: "  Spaced  ", color: "chartreuse" },
      { match: "no-name.com" },
      { name: "no-match" },
      null,
      "nope",
    ],
  });
  assert.deepEqual(rules, [
    { match: "github.com", name: "Code", color: "blue" },
    { match: "spaced.com", name: "Spaced", color: "blue" },
  ]);
});

test("sanitize: exceptions are trimmed, lower-cased and de-duplicated", () => {
  assert.deepEqual(sanitize({ exceptions: [" Google.COM ", "google.com", "", "  "] }).exceptions, [
    "google.com",
  ]);
});

test("sanitize: numbers are clamped into a usable range", () => {
  assert.equal(sanitize({ minTabsToGroup: 0 }).minTabsToGroup, 1);
  assert.equal(sanitize({ minTabsToGroup: 999 }).minTabsToGroup, 20);
  assert.equal(sanitize({ minTabsToGroup: "abc" }).minTabsToGroup, 2);
  assert.equal(sanitize({ collapseThreshold: -5 }).collapseThreshold, 0);
  assert.equal(sanitize({ discardDelayMin: 0 }).discardDelayMin, 1);
});

test("sanitize: is idempotent, so an exported file re-imports unchanged", () => {
  const once = sanitize({
    rules: [{ match: "github.com", name: "Code", color: "red" }],
    exceptions: ["localhost"],
    minTabsToGroup: 3,
  });
  assert.deepEqual(sanitize(once), once);
});

// --- migration ------------------------------------------------------------

test("migration: settings left in sync are adopted once, then stamped", async () => {
  const world = install({
    sync: { enabled: false, minTabsToGroup: 5, rules: [{ match: "a.com", name: "A" }] },
  });

  const s = await getSettings();
  assert.equal(s.enabled, false, "the old value came across");
  assert.equal(s.minTabsToGroup, 5);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.equal(world.storage.local.minTabsToGroup, 5, "and was written to local");
  assert.ok(Object.keys(world.storage.sync).length, "the sync copy is left for a downgrade");

  // Second read is a plain read: no sync lookup, no rewrite.
  const before = world.calls["storage.local.set"];
  await getSettings();
  assert.equal(world.calls["storage.local.set"], before, "migration does not run twice");
});

test("migration: a fresh profile just gets the defaults", async () => {
  const world = install();
  const s = await getSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.equal(world.storage.local.schemaVersion, SCHEMA_VERSION);
});

test("migration: local wins over a stale sync copy", async () => {
  install({ local: { minTabsToGroup: 7 }, sync: { minTabsToGroup: 2 } });
  assert.equal((await getSettings()).minTabsToGroup, 7);
});

test("getSettings: unreachable storage yields defaults instead of throwing", async () => {
  install();
  globalThis.chrome.storage.local.get = async () => {
    throw new Error("Extension context invalidated.");
  };
  const s = await getSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.minTabsToGroup, 2);
});

// --- writing --------------------------------------------------------------

test("setSettings: merges onto what's stored and cleans the result", async () => {
  const world = install({ local: { schemaVersion: SCHEMA_VERSION, minTabsToGroup: 4 } });
  const next = await setSettings({ rules: [{ match: "x.com", name: "X", color: "nope" }] });

  assert.equal(next.minTabsToGroup, 4, "untouched keys survive");
  assert.deepEqual(next.rules, [{ match: "x.com", name: "X", color: "blue" }]);
  assert.deepEqual(world.storage.local.rules, next.rules);
});

test("setSettings: a refused write reaches the caller", async () => {
  install({ local: { schemaVersion: SCHEMA_VERSION } });
  globalThis.chrome.storage.local.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };
  await assert.rejects(() => setSettings({ enabled: false }), /QUOTA_BYTES/);
});
