// popup.js — the front desk. Sends requests to the librarian (background worker).

import { duplicateCount } from "./lib/dedupe.js";

async function currentWindowId() {
  const w = await chrome.windows.getCurrent();
  return w.id;
}

async function send(type, extra = {}) {
  try {
    const windowId = await currentWindowId();
    return await chrome.runtime.sendMessage({ type, windowId, ...extra });
  } catch {
    // The worker is still booting, or it died mid-call. One null here keeps every
    // caller on a single path instead of leaving a button stuck mid-sentence.
    return null;
  }
}

const OUT = "the librarian is out — try again.";

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

async function loadDuplicates() {
  const section = document.querySelector(".dupes");
  const list = document.getElementById("dupe-list");
  const closeBtn = document.getElementById("close-dupes");
  const res = await send("GET_DUPLICATES");
  const groups = res?.groups || [];

  // Auto-close keeps duplicates from piling up, so hide the whole section when
  // there's nothing to clean — the popup stays short.
  if (!groups.length) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  const redundant = duplicateCount(groups);
  list.className = "";
  list.innerHTML = "";
  for (const g of groups) {
    const t = g.tabs[0];
    const item = document.createElement("div");
    item.className = "dupe-item";
    const icon = document.createElement("img");
    icon.src = t.favIconUrl || "";
    icon.onerror = () => (icon.style.visibility = "hidden");
    const label = document.createElement("span");
    label.textContent = `${t.title || t.url} ×${g.tabs.length}`;
    item.append(icon, label);
    list.append(item);
  }
  closeBtn.style.display = "block";
  closeBtn.textContent = `Close ${redundant} duplicate${redundant > 1 ? "s" : ""}`;
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/** The offer only exists while the background worker still remembers the action
 *  (five minutes), so this asks rather than tracking anything itself. */
async function loadUndo() {
  const bar = document.querySelector(".undo-bar");
  const res = await send("GET_UNDO");
  if (!res?.action) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "";
  document.getElementById("undo").textContent =
    `Undo — ${res.action.label}, ${ago(res.action.at)}`;
}

// --- find a tab ------------------------------------------------------------
// The real reason tabs pile up: it's easier to press Ctrl+T than to find the one
// you already have open. No background round-trip — the popup has the same tabs
// permission the worker does.

const TAB_GROUP_ID_NONE = -1;
const q = document.getElementById("q");
const results = document.getElementById("results");
let matches = [];
let cursor = 0;

function paintCursor() {
  [...results.children].forEach((el, i) => el.classList.toggle("on", i === cursor));
}

async function search(term) {
  const needle = term.trim().toLowerCase();
  document.body.classList.toggle("searching", needle.length > 0);
  results.replaceChildren();
  matches = [];
  cursor = 0;
  if (!needle) return;

  const tabs = await chrome.tabs.query({});
  matches = tabs
    .filter((t) => `${t.title || ""} ${t.url || ""}`.toLowerCase().includes(needle))
    .slice(0, 12);

  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "dupe-empty";
    empty.textContent = "nothing on the shelves.";
    results.append(empty);
    return;
  }

  matches.forEach((tab, i) => {
    const item = document.createElement("div");
    item.className = "result";
    const icon = document.createElement("img");
    icon.src = tab.favIconUrl || "";
    icon.onerror = () => (icon.style.visibility = "hidden");
    const label = document.createElement("span");
    label.textContent = tab.title || tab.url;
    item.append(icon, label);
    item.addEventListener("click", () => jump(i));
    results.append(item);
  });
  paintCursor();
}

/** Go to a tab, opening its shelf first if it's folded shut. */
async function jump(i) {
  const tab = matches[i];
  if (!tab) return;
  try {
    if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE) {
      await chrome.tabGroups.update(tab.groupId, { collapsed: false });
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  } catch {
    setStatus("that one is already gone.");
    search(q.value);
  }
}

q.addEventListener("input", () => search(q.value));
q.addEventListener("keydown", (e) => {
  if (!matches.length) return;
  if (e.key === "ArrowDown") {
    cursor = (cursor + 1) % matches.length;
  } else if (e.key === "ArrowUp") {
    cursor = (cursor - 1 + matches.length) % matches.length;
  } else if (e.key === "Enter") {
    jump(cursor);
    e.preventDefault();
    return;
  } else {
    return;
  }
  e.preventDefault();
  paintCursor();
});

// --- wire up buttons -------------------------------------------------------

document.getElementById("shelve").addEventListener("click", async () => {
  setStatus("shelving…");
  const res = await send("SHELVE_NOW");
  setStatus(res?.ok ? "shelved." : OUT);
  loadDuplicates();
});

document.getElementById("hush").addEventListener("click", () => send("HUSH"));
document.getElementById("expand").addEventListener("click", () => send("EXPAND_ALL"));

document.getElementById("ungroup").addEventListener("click", async () => {
  const res = await send("UNGROUP_ALL");
  setStatus(res?.ok ? "back to one long shelf." : OUT);
  loadUndo();
});

document.getElementById("close-dupes").addEventListener("click", async () => {
  const res = await send("CLOSE_DUPLICATES");
  setStatus(res?.ok ? `closed ${res.closed}.` : OUT);
  loadDuplicates();
  loadUndo();
});

document.getElementById("undo").addEventListener("click", async () => {
  const res = await send("UNDO");
  setStatus(res?.ok ? `put back ${res.restored}.` : OUT);
  loadUndo();
  loadDuplicates();
});

async function paintPause() {
  const state = await send("GET_STATE");
  const paused = (state?.pausedUntil || 0) > Date.now();
  document.getElementById("pause").textContent = paused ? "Resume" : "Pause 1h";
  if (paused) setStatus("off duty.");
}

document.getElementById("pause").addEventListener("click", async () => {
  const state = await send("GET_STATE");
  if ((state?.pausedUntil || 0) > Date.now()) {
    await send("RESUME");
    setStatus("back on duty.");
  } else {
    const res = await send("PAUSE", { minutes: 60 });
    setStatus(res?.ok ? `hands off for ${res.minutes} min.` : OUT);
  }
  paintPause();
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

q.focus();
loadDuplicates();
loadUndo();
paintPause();
