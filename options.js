// options.js — the librarian's preferences.

import { getSettings, setSettings } from "./lib/storage.js";
import { GROUP_COLORS } from "./lib/domain.js";

const $ = (id) => document.getElementById(id);
const CHECKS = ["enabled", "autoCollapse", "mergeSubdomains", "dedupeAutoClose", "dedupeIgnoreFragment", "dedupeIgnoreQuery"];
const NUMS = ["minTabsToGroup", "collapseThreshold"];

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

async function load() {
  const s = await getSettings();
  for (const k of CHECKS) $(k).checked = !!s[k];
  for (const k of NUMS) $(k).value = s[k];
  $("exceptions").value = (s.exceptions || []).join("\n");
  const body = $("rules-body");
  body.innerHTML = "";
  for (const r of s.rules || []) body.append(ruleRow(r));
}

async function save() {
  const patch = {};
  for (const k of CHECKS) patch[k] = $(k).checked;
  for (const k of NUMS) patch[k] = Math.max(0, parseInt($(k).value, 10) || 0);
  patch.minTabsToGroup = Math.max(1, patch.minTabsToGroup); // never below 1
  patch.exceptions = $("exceptions").value
    .split("\n")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  patch.rules = collectRules();
  await setSettings(patch);
  const saved = $("saved");
  saved.textContent = "saved ✓";
  setTimeout(() => (saved.textContent = ""), 1500);
}

$("add-rule").addEventListener("click", () => $("rules-body").append(ruleRow()));
$("save").addEventListener("click", save);
load();
