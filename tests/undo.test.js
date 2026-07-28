// Undo: what gets remembered, what comes back, and what happens when the browser's
// own session list can't help.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeWorld, makeChrome } from "./fake-chrome.js";
import { rememberClosed, rememberUngrouped, recall, forget, undo } from "../lib/undo.js";

function install(init = {}) {
  const world = makeWorld(init);
  globalThis.chrome = makeChrome(world);
  return world;
}

const NOW = 1_700_000_000_000;

test("closing duplicates is remembered with a session id each", async () => {
  const world = install({
    tabs: [
      { id: 1, url: "https://example.com/p" },
      { id: 2, url: "https://example.com/p" },
      { id: 3, url: "https://example.com/p" },
    ],
  });
  const doomed = world.tabs.slice(1).map((t) => ({ ...t }));
  await chrome.tabs.remove(doomed.map((t) => t.id));
  await rememberClosed(doomed, { kind: "close-dupes", now: NOW });

  const action = await recall(NOW);
  assert.equal(action.kind, "close-dupes");
  assert.equal(action.closed.length, 2);
  // Duplicates share a URL, so a naive URL->id map would give both the same id.
  const ids = action.closed.map((c) => c.sessionId);
  assert.equal(new Set(ids).size, 2, "two closed tabs, two distinct session ids");
});

test("undo puts the closed tabs back", async () => {
  const world = install({
    tabs: [
      { id: 1, url: "https://example.com/p" },
      { id: 2, url: "https://example.com/p" },
    ],
  });
  const doomed = [{ ...world.tabs[1] }];
  await chrome.tabs.remove([2]);
  await rememberClosed(doomed, { now: NOW });

  const res = await undo(NOW);
  assert.equal(res.ok, true);
  assert.equal(res.restored, 1);
  assert.equal(world.tabs.length, 2);
  assert.equal(world.calls["sessions.restore"], 1);
});

test("undo falls back to reopening the URL when the session is gone", async () => {
  const world = install({
    tabs: [
      { id: 1, url: "https://example.com/p" },
      { id: 2, url: "https://example.com/p" },
    ],
  });
  const doomed = [{ ...world.tabs[1] }];
  await chrome.tabs.remove([2]);
  await rememberClosed(doomed, { now: NOW });

  // The browser forgot the session — expired, or already restored elsewhere.
  world.closedStack.length = 0;

  const res = await undo(NOW);
  assert.equal(res.restored, 1, "the page comes back even so");
  assert.ok(
    world.tabs.some((t) => t.url === "https://example.com/p" && t.id !== 1),
    "reopened via tabs.create"
  );
});

test("undo survives a browser with no sessions list at all", async () => {
  const world = install({ tabs: [{ id: 1, url: "https://example.com/p" }] });
  const doomed = [{ ...world.tabs[0] }];
  await chrome.tabs.remove([1]);
  chrome.sessions.getRecentlyClosed = async () => {
    throw new Error("not available");
  };
  await rememberClosed(doomed, { now: NOW });

  const action = await recall(NOW);
  assert.equal(action.closed[0].sessionId, undefined);
  assert.equal((await undo(NOW)).restored, 1);
});

test("auto-closes accumulate into one offer", async () => {
  const world = install({
    tabs: [
      { id: 1, url: "https://a.com" },
      { id: 2, url: "https://b.com" },
    ],
  });
  const a = { ...world.tabs[0] };
  const b = { ...world.tabs[1] };
  await chrome.tabs.remove([1]);
  await rememberClosed([a], { kind: "auto-close", now: NOW });
  await chrome.tabs.remove([2]);
  await rememberClosed([b], { kind: "auto-close", now: NOW + 1000 });

  const action = await recall(NOW + 1000);
  assert.equal(action.closed.length, 2, "one offer, both tabs");
  assert.equal(action.label, "2 closed tabs");
});

test("a manual close does not fold into the accumulated auto-closes", async () => {
  const world = install({
    tabs: [
      { id: 1, url: "https://a.com" },
      { id: 2, url: "https://b.com" },
    ],
  });
  const a = { ...world.tabs[0] };
  const b = { ...world.tabs[1] };
  await chrome.tabs.remove([1]);
  await rememberClosed([a], { kind: "auto-close", now: NOW });
  await chrome.tabs.remove([2]);
  await rememberClosed([b], { kind: "close-dupes", now: NOW + 1000 });

  const action = await recall(NOW + 1000);
  assert.equal(action.kind, "close-dupes");
  assert.equal(action.closed.length, 1);
});

test("an offer older than five minutes is not made", async () => {
  const world = install({ tabs: [{ id: 1, url: "https://a.com" }] });
  const a = { ...world.tabs[0] };
  await chrome.tabs.remove([1]);
  await rememberClosed([a], { now: NOW });

  assert.ok(await recall(NOW + 4 * 60_000), "still fresh at four minutes");
  assert.equal(await recall(NOW + 6 * 60_000), null, "stale at six");
  assert.equal((await undo(NOW + 6 * 60_000)).ok, false);
});

test("undo is offered once, then gone", async () => {
  const world = install({ tabs: [{ id: 1, url: "https://a.com" }] });
  const a = { ...world.tabs[0] };
  await chrome.tabs.remove([1]);
  await rememberClosed([a], { now: NOW });

  assert.equal((await undo(NOW)).ok, true);
  assert.equal(await recall(NOW), null);
  assert.equal((await undo(NOW)).ok, false);
});

test("undo rebuilds the shelves that Unshelve everything took apart", async () => {
  const world = install({
    groups: [
      { id: 10, windowId: 1, title: "Github", color: "cyan", collapsed: true },
      { id: 11, windowId: 1, title: "Video", color: "red", collapsed: false },
    ],
    tabs: [
      { id: 1, url: "https://github.com/a", groupId: 10 },
      { id: 2, url: "https://github.com/b", groupId: 10 },
      { id: 3, url: "https://youtube.com", groupId: 11 },
    ],
  });
  const moved = world.tabs.map((t) => {
    const g = world.groups.find((x) => x.id === t.groupId);
    return {
      tabId: t.id, groupId: t.groupId, index: t.index,
      title: g.title, color: g.color, collapsed: g.collapsed,
    };
  });
  await chrome.tabs.ungroup([1, 2, 3]);
  assert.equal(world.groups.length, 0, "teardown really happened");
  await rememberUngrouped(1, moved, NOW);

  const res = await undo(NOW);
  assert.equal(res.restored, 3);
  assert.equal(world.groups.length, 2);
  const github = world.groups.find((g) => g.title === "Github");
  assert.equal(github.color, "cyan");
  assert.equal(github.collapsed, true, "even the collapsed state comes back");
  assert.deepEqual(world.groupTabs(github.id).map((t) => t.id), [1, 2]);
});

test("undo skips a shelf whose tabs are all gone, and keeps the rest", async () => {
  const world = install({
    groups: [
      { id: 10, windowId: 1, title: "Github", color: "cyan" },
      { id: 11, windowId: 1, title: "Video", color: "red" },
    ],
    tabs: [
      { id: 1, url: "https://github.com/a", groupId: 10 },
      { id: 2, url: "https://youtube.com", groupId: 11 },
    ],
  });
  const moved = world.tabs.map((t) => {
    const g = world.groups.find((x) => x.id === t.groupId);
    return { tabId: t.id, groupId: t.groupId, index: t.index, title: g.title, color: g.color, collapsed: false };
  });
  await chrome.tabs.ungroup([1, 2]);
  await rememberUngrouped(1, moved, NOW);
  await chrome.tabs.remove([2]); // that tab is closed before the user hits undo

  const res = await undo(NOW);
  assert.equal(res.restored, 1);
  assert.deepEqual(world.groups.map((g) => g.title), ["Github"]);
});

test("forget clears the offer", async () => {
  const world = install({ tabs: [{ id: 1, url: "https://a.com" }] });
  const a = { ...world.tabs[0] };
  await chrome.tabs.remove([1]);
  await rememberClosed([a], { now: NOW });
  await forget();
  assert.equal(await recall(NOW), null);
});

test("nothing closed, nothing remembered", async () => {
  install();
  await rememberClosed([], { now: NOW });
  await rememberUngrouped(1, [], NOW);
  assert.equal(await recall(NOW), null);
});
