// options.js — the librarian's preferences.

import { getSettings, setSettings, sanitize } from "./lib/storage.js";
import { GROUP_COLORS } from "./lib/domain.js";

const $ = (id) => document.getElementById(id);
const CHECKS = [
  "enabled", "autoCollapse", "mergeSubdomains", "tidyLooseTabs",
  "dedupeAutoClose", "dedupeIgnoreFragment", "dedupeIgnoreQuery",
  "discardOnCollapse",
];
const NUMS = ["minTabsToGroup", "collapseThreshold", "discardDelayMin"];

function colorSelect(selected) {
  const sel = document.createElement("select");
  for (const c of GROUP_COLORS) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === selected) opt.selected = true;
    sel.append(opt);
  }
  return sel;
}

function ruleRow(rule = { match: "", name: "", color: "blue" }) {
  const tr = document.createElement("tr");

  const tdMatch = document.createElement("td");
  const match = document.createElement("input");
  match.value = rule.match;
  match.placeholder = "github.com";
  tdMatch.append(match);

  const tdName = document.createElement("td");
  const name = document.createElement("input");
  name.value = rule.name;
  name.placeholder = "Code";
  tdName.append(name);

  const tdColor = document.createElement("td");
  const color = colorSelect(rule.color);
  tdColor.append(color);

  const tdDel = document.createElement("td");
  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "×";
  del.title = "remove rule";
  del.addEventListener("click", () => tr.remove());
  tdDel.append(del);

  tr.append(tdMatch, tdName, tdColor, tdDel);
  return tr;
}

function collectRules() {
  const rows = [...$("rules-body").querySelectorAll("tr")];
  return rows
    .map((tr) => {
      const [match, name] = tr.querySelectorAll("input");
      const color = tr.querySelector("select");
      return { match: match.value.trim(), name: name.value.trim(), color: color.value };
    })
    .filter((r) => r.match && r.name);
}

/** Focus Mode rewrites every group's collapsed state on each tab switch, so a
 *  size threshold underneath it would never survive. Say so instead of pretending
 *  both work. */
function syncCollapseThreshold() {
  const on = $("autoCollapse").checked;
  $("collapseThreshold").disabled = on;
  $("collapseThreshold-hint").textContent = on
    ? "Focus Mode is collapsing shelves — this threshold does nothing while it's on"
    : "0 = never auto-collapse by size";
}

async function load() {
  const s = await getSettings();
  for (const k of CHECKS) $(k).checked = !!s[k];
  for (const k of NUMS) $(k).value = s[k];
  $("exceptions").value = (s.exceptions || []).join("\n");
  const body = $("rules-body");
  body.innerHTML = "";
  for (const r of s.rules || []) body.append(ruleRow(r));
  syncCollapseThreshold();
}

/** One place to tell the user what happened — including when it didn't work. */
function flash(text, bad = false) {
  const saved = $("saved");
  saved.style.color = bad ? "#b03a2e" : "";
  saved.textContent = text;
  setTimeout(() => (saved.textContent = ""), bad ? 5000 : 1500);
}

async function save() {
  // Ranges and shapes are enforced by sanitize() inside setSettings; this only
  // has to read the form.
  const patch = {};
  for (const k of CHECKS) patch[k] = $(k).checked;
  for (const k of NUMS) patch[k] = parseInt($(k).value, 10);
  patch.exceptions = $("exceptions").value.split("\n");
  patch.rules = collectRules();
  try {
    await setSettings(patch);
    flash("saved ✓");
  } catch (e) {
    // A rejected write used to leave the page silent — no tick, no reason.
    flash(`not saved: ${e?.message || e}`, true);
  }
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

$("add-rule").addEventListener("click", () => $("rules-body").append(ruleRow()));
$("save").addEventListener("click", save);
$("autoCollapse").addEventListener("change", syncCollapseThreshold);

$("export").addEventListener("click", async () => {
  download("shelf-settings.json", JSON.stringify(await getSettings(), null, 2));
  flash("exported ✓");
});

$("import").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // so picking the same file twice still fires
  if (!file) return;
  try {
    // A file off disk is untrusted input; sanitize() inside setSettings is the door.
    await setSettings(JSON.parse(await file.text()));
    await load();
    flash("imported ✓");
  } catch (err) {
    flash(`could not import: ${err?.message || err}`, true);
  }
});

$("reset").addEventListener("click", async () => {
  if (!confirm("Reset every setting, rule and exception to the defaults?")) return;
  // Write the defaults rather than clearing: an empty local area would send
  // getSettings() looking in sync and resurrect the very settings we just dropped.
  await chrome.storage.local.set(sanitize(null));
  await load();
  flash("reset ✓");
});

// --- first run -------------------------------------------------------------
// Opened by the installer instead of quietly rearranging every window.

async function loadPreview() {
  const el = $("preview");
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "PREVIEW" });
  } catch {
    /* the worker is still booting */
  }
  if (!res?.ok) {
    el.textContent = "Couldn't look just now — try reloading this page.";
    return;
  }
  if (!res.shelves.length) {
    el.textContent =
      "Nothing to shelve yet. He waits until a site has two tabs open before giving it a shelf.";
    return;
  }
  const list = res.shelves.map((s) => `${s.title} (${s.count})`).join(" · ");
  const n = res.shelves.length;
  el.textContent =
    `${res.loose} loose tab${res.loose === 1 ? "" : "s"} → ` +
    `${n} shelf${n === 1 ? "" : "s"}: ${list}`;
}

if (new URLSearchParams(location.search).has("first-run")) {
  $("first-run").hidden = false;
  loadPreview();
  $("apply-first-run").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "SHELVE_ALL_WINDOWS" });
    $("first-run").hidden = true;
    flash("shelved ✓");
  });
  $("skip-first-run").addEventListener("click", () => {
    $("first-run").hidden = true;
  });
}

load();
