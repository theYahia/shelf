// Tests for the parts that talk to the browser: the shelving flow, the badge, and
// the message dispatcher. Driven through tests/fake-chrome.js — no real browser.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeWorld, makeChrome } from "./fake-chrome.js";
import { domainToColor } from "../lib/domain.js";

// background.js registers its listeners at import time, so chrome must exist first
// and every test needs its own module instance — hence the cache-busting query.
let boots = 0;
async function boot(init = {}, settings = {}) {
  const world = makeWorld({ ...init, local: { schemaVersion: 2, ...settings } });
  globalThis.chrome = makeChrome(world);
  const bg = await import(`../background.js?boot=${++boots}`);
  return { world, bg };
}

/** Put the user on `tabId` twice: the first switch seeds the worker's "last active"
 *  map (and runs its wake-up catch-up), the second is the ordinary path. */
async function activate(world, bg, tabId, windowId = 1) {
  await world.fire("tabs.onActivated", { tabId, windowId });
  await bg.idle();
}

// --- CRIT-1: a lone tab still gets a shelf when its site has siblings ------

test("CRIT-1: leaving a tab shelves it when the window already holds its siblings", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://github.com/a", active: true },
      { id: 2, url: "https://youtube.com" },
    ],
  });

  // Worker wakes with the user on tab 1. Youtube is alone -> no shelf for it.
  await activate(world, bg, 1);
  assert.equal(world.groupsIn(1).length, 0, "a lone site gets no shelf");

  // A second github tab opens, and the user leaves tab 1 for it.
  world.tabs.push({
    id: 3, windowId: 1, index: 2, groupId: -1, pinned: false,
    url: "https://github.com/b", title: "", status: "complete",
  });
  await activate(world, bg, 3);

  // The batch carried one tab — but the *window* holds two github tabs, which is
  // what minTabsToGroup is actually about. Before the fix this created nothing.
  const groups = world.groupsIn(1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Github");
  assert.deepEqual(world.groupTabs(groups[0].id).map((t) => t.id), [1]);
});

test("CRIT-1: minTabsToGroup is still honoured — one tab of a site stays loose", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://github.com", active: true },
      { id: 2, url: "https://youtube.com" },
    ],
  });
  await activate(world, bg, 2); // leaves tab 1, the only github tab
  assert.equal(world.groupsIn(1).length, 0);
});

test("CRIT-1: an existing shelf takes a lone tab regardless of the threshold", async () => {
  const { world, bg } = await boot({
    groups: [{ id: 50, windowId: 1, title: "Github", color: "cyan" }],
    tabs: [
      { id: 1, url: "https://github.com/a", groupId: 50 },
      { id: 2, url: "https://youtube.com", active: true },
      { id: 3, url: "https://github.com/b" }, // loose, wants to join
    ],
  });
  await activate(world, bg, 2);
  assert.equal(world.groupsIn(1).length, 1, "no second Github shelf appears");
  assert.deepEqual(world.groupTabs(50).map((t) => t.id), [1, 3]);
});

test("CRIT-1: waking up costs one pass, not one per tab", async () => {
  const tabs = [{ id: 1, url: "https://github.com/0", active: true }];
  for (let i = 1; i < 20; i++) tabs.push({ id: i + 1, url: `https://github.com/${i}` });
  const { world, bg } = await boot({ tabs });

  await activate(world, bg, 1); // prev == null -> the catch-up branch

  // The old per-tab loop queried the group list once per tab. One shelving pass
  // plus Focus Mode's own look is the ceiling.
  assert.ok(
    world.calls["tabGroups.query"] <= 2,
    `expected <= 2 group queries, got ${world.calls["tabGroups.query"]}`
  );
  assert.ok(
    world.calls["storage.local.get"] <= 3,
    `expected <= 3 settings reads, got ${world.calls["storage.local.get"]}`
  );
  assert.equal(world.groupsIn(1).length, 1);
  assert.equal(world.groupTabs(world.groupsIn(1)[0].id).length, 19, "all but the active tab");
});

// --- CRIT-4: shelves are keyed by domain, not by display title -------------

test("CRIT-4: two sites that share a title get a shelf each", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://example.com/a", active: true },
      { id: 2, url: "https://example.com/b" },
      { id: 3, url: "https://example.org/a" },
      { id: 4, url: "https://example.org/b" },
    ],
  });
  await activate(world, bg, 1);

  const groups = world.groupsIn(1);
  assert.equal(groups.length, 2, "example.com and example.org are two sites, not one");
  // Both want to be called "Example"; whoever gets there second is named by its key.
  const titles = groups.map((g) => g.title).sort();
  assert.deepEqual(titles, ["Example", "example.org"]);
  // And nobody was mixed into the wrong shelf.
  for (const g of groups) {
    const hosts = new Set(world.groupTabs(g.id).map((t) => new URL(t.url).hostname));
    assert.equal(hosts.size, 1, `${g.title} holds one site`);
  }
});

test("CRIT-4: a hosting suffix separates two strangers on the same host", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://example.org", active: true },
      { id: 2, url: "https://alice.github.io/x" },
      { id: 3, url: "https://alice.github.io/y" },
      { id: 4, url: "https://bob.github.io/x" },
      { id: 5, url: "https://bob.github.io/y" },
    ],
  });
  await activate(world, bg, 1);

  const groups = world.groupsIn(1);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.title).sort(), ["Alice", "Bob"]);
});

test("CRIT-4: an existing shelf is found by what's in it, even renamed by hand", async () => {
  const { world, bg } = await boot({
    groups: [{ id: 60, windowId: 1, title: "Work", color: "purple" }],
    tabs: [
      { id: 1, url: "https://github.com/a", groupId: 60 },
      { id: 2, url: "https://github.com/b", groupId: 60 },
      { id: 3, url: "https://github.com/c" }, // loose
      { id: 4, url: "https://youtube.com", active: true },
    ],
  });
  await activate(world, bg, 4);

  assert.equal(world.groupsIn(1).length, 1, "no rival Github shelf");
  assert.equal(world.groupsIn(1)[0].title, "Work", "the manual name is left alone");
  assert.deepEqual(world.groupTabs(60).map((t) => t.id), [1, 2, 3]);
});

test("CRIT-4: a hand-made mixed group has no majority key and is not colonised", async () => {
  const { world, bg } = await boot({
    groups: [{ id: 70, windowId: 1, title: "Reading", color: "pink" }],
    tabs: [
      { id: 1, url: "https://github.com/a", groupId: 70 },
      { id: 2, url: "https://youtube.com/a", groupId: 70 },
      { id: 3, url: "https://github.com/b" },
      { id: 4, url: "https://github.com/c" },
      { id: 5, url: "https://example.org", active: true },
    ],
  });
  await activate(world, bg, 5);

  assert.deepEqual(world.groupTabs(70).map((t) => t.id), [1, 2], "the mixed group is untouched");
  const fresh = world.groupsIn(1).find((g) => g.id !== 70);
  assert.ok(fresh, "the loose github tabs got their own shelf");
  assert.deepEqual(world.groupTabs(fresh.id).map((t) => t.id), [3, 4]);
});

// --- CRIT-5: colour is a property of the site, not of creation order ------

test("CRIT-5: a shelf's colour is derived from its domain", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://youtube.com/a", active: true },
      { id: 2, url: "https://youtube.com/b" },
      { id: 3, url: "https://github.com/a" },
      { id: 4, url: "https://github.com/b" },
    ],
  });
  await activate(world, bg, 1);

  const byTitle = new Map(world.groupsIn(1).map((g) => [g.title, g]));
  assert.equal(byTitle.get("Github").color, domainToColor("github.com"));
  assert.equal(byTitle.get("Youtube").color, domainToColor("youtube.com"));
});

test("CRIT-5: creation order does not change the colour", async () => {
  const colourOf = async (order) => {
    const { world, bg } = await boot({
      tabs: [
        { id: 1, url: "https://example.org", active: true },
        ...order.flatMap((host, i) => [
          { id: 10 + i * 2, url: `https://${host}/a` },
          { id: 11 + i * 2, url: `https://${host}/b` },
        ]),
      ],
    });
    await activate(world, bg, 1);
    return world.groupsIn(1).find((g) => g.title === "Github").color;
  };
  assert.equal(
    await colourOf(["github.com", "youtube.com"]),
    await colourOf(["youtube.com", "github.com"])
  );
});

// --- exceptions and rules -------------------------------------------------

test("MED-10: an exception spares subdomains, and a rule cannot override it", async () => {
  const { world, bg } = await boot(
    {
      tabs: [
        { id: 1, url: "https://mail.google.com/a", active: true },
        { id: 2, url: "https://mail.google.com/b" },
        { id: 3, url: "https://github.com/a" },
        { id: 4, url: "https://github.com/b" },
      ],
    },
    {
      exceptions: ["google.com"],
      rules: [{ match: "google.com", name: "Mail", color: "red" }],
    }
  );
  await activate(world, bg, 1);

  const titles = world.groupsIn(1).map((g) => g.title);
  assert.deepEqual(titles, ["Github"], "google is left alone despite the rule");
});

// --- HIGH-8: closing duplicates ------------------------------------------

test("HIGH-8: a stale id does not sink the whole close, and the popup gets an answer", async () => {
  const { world } = await boot({
    tabs: [
      { id: 1, url: "https://example.com/p", active: true },
      { id: 2, url: "https://example.com/p" },
      { id: 3, url: "https://other.com/x" },
      { id: 4, url: "https://other.com/x" },
    ],
  });

  const real = globalThis.chrome.tabs.remove;
  globalThis.chrome.tabs.remove = async (id) => {
    if (id === 4) throw new Error("No tab with id: 4."); // vanished mid-flight
    return real(id);
  };

  const res = await globalThis.chrome.runtime.sendMessage({
    type: "CLOSE_DUPLICATES",
    windowId: 1,
  });

  assert.equal(res.ok, true, "the dispatcher answered");
  assert.equal(res.closed, 1, "the survivor was still closed");
  assert.ok(!world.tabs.some((t) => t.id === 2), "tab 2 is gone");
  assert.ok(world.tabs.some((t) => t.id === 4), "tab 4 stayed, and took nothing with it");
});

test("HIGH-8: a pinned duplicate is kept, never closed", async () => {
  const { world } = await boot({
    tabs: [
      { id: 1, url: "https://example.com/p" },
      { id: 2, url: "https://example.com/p", pinned: true },
      { id: 3, url: "https://example.com/p" },
    ],
  });

  const res = await globalThis.chrome.runtime.sendMessage({
    type: "CLOSE_DUPLICATES",
    windowId: 1,
  });

  assert.equal(res.closed, 2, "both unpinned copies go");
  assert.deepEqual(world.tabs.map((t) => t.id), [2], "the pinned one is the keeper");
});

test("badge counts what the button could actually close", async () => {
  const { world } = await boot({
    tabs: [
      { id: 1, url: "chrome://newtab/", active: true },
      { id: 2, url: "chrome://newtab/" },
      { id: 3, url: "https://example.com/p" },
      { id: 4, url: "https://example.com/p" },
    ],
  });
  // CLOSE_DUPLICATES refreshes the badge on the way out, so this exercises both.
  await globalThis.chrome.runtime.sendMessage({ type: "CLOSE_DUPLICATES", windowId: 1 });
  assert.equal(world.badge.text, "", "nothing left to count");
  assert.equal(world.tabs.length, 3, "only the real duplicate was closed");
});

// --- undo, end to end through the popup's messages ------------------------

test("closing duplicates leaves an undo the popup can offer and take", async () => {
  const { world } = await boot({
    tabs: [
      { id: 1, url: "https://example.com/p", active: true },
      { id: 2, url: "https://example.com/p" },
      { id: 3, url: "https://example.com/p" },
    ],
  });
  const send = (type) => globalThis.chrome.runtime.sendMessage({ type, windowId: 1 });

  assert.equal((await send("GET_UNDO")).action, null, "nothing to undo yet");

  await send("CLOSE_DUPLICATES");
  assert.equal(world.tabs.length, 1);

  const offer = (await send("GET_UNDO")).action;
  assert.equal(offer.label, "2 closed tabs");

  const res = await send("UNDO");
  assert.equal(res.restored, 2);
  assert.equal(world.tabs.length, 3, "both duplicates are back");
  assert.equal((await send("GET_UNDO")).action, null, "and the offer is spent");
});

test("auto-close leaves an undo too", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://example.com/p", active: true },
      { id: 2, url: "https://example.com/p" },
    ],
  });
  await world.fire("tabs.onUpdated", 2, { status: "complete" }, world.tabs[1]);
  await bg.idle();
  assert.equal(world.tabs.length, 1, "the duplicate was closed");

  const offer = await globalThis.chrome.runtime.sendMessage({ type: "GET_UNDO", windowId: 1 });
  assert.equal(offer.action.label, "1 closed tab");

  const res = await globalThis.chrome.runtime.sendMessage({ type: "UNDO", windowId: 1 });
  assert.equal(res.restored, 1);
  assert.equal(world.tabs.length, 2);
});

test("Unshelve everything can be taken back", async () => {
  const { world } = await boot({
    groups: [{ id: 20, windowId: 1, title: "Github", color: "cyan", collapsed: true }],
    tabs: [
      { id: 1, url: "https://github.com/a", groupId: 20, active: true },
      { id: 2, url: "https://github.com/b", groupId: 20 },
    ],
  });
  const send = (type) => globalThis.chrome.runtime.sendMessage({ type, windowId: 1 });

  await send("UNGROUP_ALL");
  assert.equal(world.groupsIn(1).length, 0);

  assert.equal((await send("GET_UNDO")).action.label, "1 shelf taken apart");
  await send("UNDO");

  const groups = world.groupsIn(1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Github");
  assert.equal(groups[0].color, "cyan");
  assert.equal(groups[0].collapsed, true);
});

// --- pause ----------------------------------------------------------------

test("pause: nothing moves until the hour is up, then it does again", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://github.com/a", active: true },
      { id: 2, url: "https://github.com/b" },
    ],
  });
  const send = (type, extra) =>
    globalThis.chrome.runtime.sendMessage({ type, windowId: 1, ...extra });

  await send("PAUSE", { minutes: 60 });
  await activate(world, bg, 2);
  assert.equal(world.groupsIn(1).length, 0, "off duty: the tabs stay where they are");

  await send("RESUME");
  await activate(world, bg, 1);
  assert.equal(world.groupsIn(1).length, 1, "back on duty");
});

test("pause: auto-close is off duty too", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://example.com/p", active: true },
      { id: 2, url: "https://example.com/p" },
    ],
  });
  await globalThis.chrome.runtime.sendMessage({ type: "PAUSE", windowId: 1, minutes: 60 });
  await world.fire("tabs.onUpdated", 2, { status: "complete" }, world.tabs[1]);
  await bg.idle();
  assert.equal(world.tabs.length, 2, "the duplicate is left alone");
});

// --- discarding collapsed shelves ----------------------------------------

test("discard: off by default — a collapsed shelf sets no alarm", async () => {
  const { world } = await boot({
    groups: [{ id: 30, windowId: 1, title: "Github", collapsed: true }],
    tabs: [{ id: 1, url: "https://github.com/a", groupId: 30 }],
  });
  await world.fire("tabGroups.onUpdated", { id: 30, windowId: 1, collapsed: true });
  assert.equal(world.alarm, undefined, "nothing scheduled without opting in");
});

test("discard: unloads a collapsed shelf, and only what's safe to take", async () => {
  const { world } = await boot(
    {
      groups: [
        { id: 30, windowId: 1, title: "Github", collapsed: true },
        { id: 31, windowId: 1, title: "Local", collapsed: true },
        { id: 32, windowId: 1, title: "Video", collapsed: false },
      ],
      tabs: [
        { id: 1, url: "https://github.com/a", groupId: 30 },
        { id: 2, url: "https://github.com/b", groupId: 30, active: true },
        { id: 3, url: "https://github.com/c", groupId: 30, audible: true },
        { id: 4, url: "https://github.com/d", groupId: 30, status: "loading" },
        { id: 5, url: "http://localhost:3000/", groupId: 31 },
        { id: 6, url: "https://youtube.com/", groupId: 32 },
      ],
    },
    { discardOnCollapse: true, discardDelayMin: 1, exceptions: ["localhost"] }
  );

  await world.fire("tabGroups.onUpdated", { id: 30, windowId: 1, collapsed: true });
  assert.ok(world.alarm, "the clock is running");
  await world.fire("alarms.onAlarm", { name: world.alarm.name });

  const gone = world.tabs.filter((t) => t.discarded).map((t) => t.id);
  assert.deepEqual(gone, [1], "the tab you're on, one making noise, one still loading, an exception and an open shelf all stay");
});

test("discard: an expanded shelf keeps its tabs loaded", async () => {
  const { world } = await boot(
    {
      groups: [{ id: 30, windowId: 1, title: "Github", collapsed: false }],
      tabs: [
        { id: 1, url: "https://github.com/a", groupId: 30 },
        { id: 2, url: "https://other.com", active: true },
      ],
    },
    { discardOnCollapse: true }
  );
  await world.fire("tabGroups.onUpdated", { id: 30, windowId: 1, collapsed: true });
  await world.fire("alarms.onAlarm", { name: world.alarm.name });
  assert.equal(world.tabs.filter((t) => t.discarded).length, 0, "the shelf was reopened before the alarm fired");
});

// --- tidying the strays ---------------------------------------------------

const strip = (world, windowId = 1) =>
  world
    .tabsIn(windowId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id);

test("strays are swept to the end so the shelves aren't broken up", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://github.com/a" },
      { id: 2, url: "https://lonely-one.com" }, // stray, wedged between shelves
      { id: 3, url: "https://github.com/b" },
      { id: 4, url: "https://youtube.com/a" },
      { id: 5, url: "https://lonely-two.com" }, // another one
      { id: 6, url: "https://youtube.com/b" },
      { id: 7, url: "https://example.org", active: true },
    ],
  });

  await activate(world, bg, 7);

  assert.deepEqual(
    strip(world),
    [1, 3, 4, 6, 7, 2, 5],
    "grouped tabs keep their places, strays go last, the active tab stays put"
  );
});

test("tidying keeps the strays in the order they were in", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://zzz.com" },
      { id: 2, url: "https://github.com/a" },
      { id: 3, url: "https://aaa.com" },
      { id: 4, url: "https://github.com/b" },
      { id: 5, url: "https://example.org", active: true },
    ],
  });
  await activate(world, bg, 5);
  assert.deepEqual(strip(world).slice(-2), [1, 3], "zzz was first, so it stays first");
});

test("tidying doesn't shuffle a strip that's already tidy", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://github.com/a" },
      { id: 2, url: "https://lonely.com" },
      { id: 3, url: "https://github.com/b" },
      { id: 4, url: "https://example.org", active: true },
    ],
  });

  await activate(world, bg, 4); // untidy -> one sweep
  assert.deepEqual(strip(world), [1, 3, 4, 2]);
  const swept = world.calls["tabs.move"];
  assert.equal(swept, 1, "the sweep happened");

  // Another shelving pass over an already-tidy strip must not touch it: a pointless
  // move still makes every tab jump.
  await activate(world, bg, 1);
  assert.equal(world.calls["tabs.move"], swept, "no second move, no flicker");
});

test("sweeping can be switched off", async () => {
  const { world, bg } = await boot(
    {
      tabs: [
        { id: 1, url: "https://github.com/a" },
        { id: 2, url: "https://lonely.com" },
        { id: 3, url: "https://github.com/b" },
        { id: 4, url: "https://example.org", active: true },
      ],
    },
    { tidyLooseTabs: false }
  );
  await activate(world, bg, 4);
  assert.deepEqual(strip(world), [1, 2, 3, 4], "the strip is left exactly as it was");
});

test("pinned tabs are not swept anywhere", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://pinned.com", pinned: true },
      { id: 2, url: "https://github.com/a" },
      { id: 3, url: "https://lonely.com" },
      { id: 4, url: "https://github.com/b" },
      { id: 5, url: "https://example.org", active: true },
    ],
  });
  await activate(world, bg, 5);
  assert.equal(strip(world)[0], 1, "the pinned tab keeps its place at the front");
});

// --- first run ------------------------------------------------------------

test("installing moves nothing — it opens a page and asks", async () => {
  const { world } = await boot({
    tabs: [
      { id: 1, url: "https://github.com/a", active: true },
      { id: 2, url: "https://github.com/b" },
    ],
  });

  await world.fire("runtime.onInstalled", { reason: "install" });

  assert.equal(world.groupsIn(1).length, 0, "nothing was rearranged behind their back");
  assert.ok(
    world.tabs.some((t) => t.url.includes("options.html?first-run")),
    "the first-run page was opened"
  );
});

test("an update does not reopen the first-run page", async () => {
  const { world } = await boot({ tabs: [{ id: 1, url: "https://github.com", active: true }] });
  await world.fire("runtime.onInstalled", { reason: "update" });
  assert.equal(world.tabs.length, 1);
});

test("PREVIEW describes the plan without carrying it out", async () => {
  const { world } = await boot({
    tabs: [
      { id: 1, url: "https://github.com/a", active: true },
      { id: 2, url: "https://github.com/b" },
      { id: 3, url: "https://youtube.com" }, // alone: no shelf
    ],
  });

  const res = await globalThis.chrome.runtime.sendMessage({ type: "PREVIEW" });
  assert.equal(res.ok, true);
  assert.equal(res.loose, 3);
  assert.deepEqual(
    res.shelves.map((s) => [s.title, s.count]),
    [["Github", 2]],
    "the lone youtube tab is not promised a shelf"
  );
  assert.equal(world.groupsIn(1).length, 0, "and still nothing has moved");

  // Saying yes does what the preview said.
  await globalThis.chrome.runtime.sendMessage({ type: "SHELVE_ALL_WINDOWS" });
  assert.deepEqual(world.groupsIn(1).map((g) => g.title), ["Github"]);
});

// --- dispatcher robustness ------------------------------------------------

test("the dispatcher always answers, even when the browser throws", async () => {
  await boot({ tabs: [{ id: 1, url: "https://example.com", active: true }] });
  globalThis.chrome.tabs.query = async () => {
    throw new Error("boom");
  };
  const res = await globalThis.chrome.runtime.sendMessage({
    type: "GET_DUPLICATES",
    windowId: 1,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /boom/);
});

test("an unknown message is refused rather than ignored", async () => {
  await boot({ tabs: [{ id: 1, url: "https://example.com", active: true }] });
  const res = await globalThis.chrome.runtime.sendMessage({ type: "NOPE", windowId: 1 });
  assert.equal(res.ok, false);
});

// --- CRIT-2 end to end: auto-close leaves hash routes alone ---------------

test("CRIT-2: auto-close ignores the loose settings and spares #/ routes", async () => {
  const { world, bg } = await boot(
    {
      tabs: [
        { id: 1, url: "https://app.example.com/#/inbox", active: true },
        { id: 2, url: "https://app.example.com/#/billing" },
      ],
    },
    { dedupeAutoClose: true, dedupeIgnoreFragment: true }
  );

  await world.fire("tabs.onUpdated", 2, { status: "complete" }, world.tabs[1]);
  await bg.idle();

  assert.equal(world.tabs.length, 2, "two different pages of one app both survive");
});

test("CRIT-2: auto-close still closes a genuine duplicate", async () => {
  const { world, bg } = await boot({
    tabs: [
      { id: 1, url: "https://example.com/p", active: true },
      { id: 2, url: "https://example.com/p" },
    ],
  });

  await world.fire("tabs.onUpdated", 2, { status: "complete" }, world.tabs[1]);
  await bg.idle();

  assert.deepEqual(world.tabs.map((t) => t.id), [1]);
});

// --- HIGH-9: a tab dragged to another window is not hauled back -----------

test("HIGH-9: a tab that moved windows is shelved where it landed", async () => {
  const { world, bg } = await boot({
    windows: [
      { id: 1, focused: false },
      { id: 2, focused: true },
    ],
    tabs: [
      { id: 1, url: "https://github.com/a", windowId: 2 },
      { id: 2, url: "https://github.com/b", windowId: 2 },
    ],
  });

  await world.fire("tabs.onAttached", 1, { newWindowId: 2, newPosition: 0 });
  await bg.idle();

  assert.equal(world.groupsIn(1).length, 0, "nothing was created in the window it left");
  const groups = world.groupsIn(2);
  assert.equal(groups.length, 1);
  assert.equal(world.tabs.find((t) => t.id === 1).windowId, 2, "the tab stayed put");
});
