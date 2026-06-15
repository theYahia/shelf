// popup.js — the front desk. Sends requests to the librarian (background worker).

async function currentWindowId() {
  const w = await chrome.windows.getCurrent();
  return w.id;
}

async function send(type, extra = {}) {
  const windowId = await currentWindowId();
  return chrome.runtime.sendMessage({ type, windowId, ...extra });
}

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

  const redundant = groups.reduce((n, g) => n + (g.tabs.length - 1), 0);
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

// --- wire up buttons -------------------------------------------------------

document.getElementById("shelve").addEventListener("click", async () => {
  setStatus("shelving…");
  await send("SHELVE_NOW");
  setStatus("shelved.");
  loadDuplicates();
});

document.getElementById("hush").addEventListener("click", () => send("HUSH"));
document.getElementById("expand").addEventListener("click", () => send("EXPAND_ALL"));

document.getElementById("ungroup").addEventListener("click", async () => {
  await send("UNGROUP_ALL");
  setStatus("back to one long shelf.");
});

document.getElementById("close-dupes").addEventListener("click", async () => {
  const res = await send("CLOSE_DUPLICATES");
  setStatus(`closed ${res?.closed || 0}.`);
  loadDuplicates();
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

loadDuplicates();
