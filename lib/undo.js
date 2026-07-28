// undo.js — the librarian's short memory.
//
// shelf does three things a user can regret: it closes a duplicate by itself, it
// closes a pile of them on request, and it takes every shelf apart. This records
// the last one so the popup can offer to put it back.
//
// State lives in chrome.storage.session: the service worker is ephemeral, so a
// module variable would not survive the five minutes the offer is good for — and
// storage.session is wiped when the browser restarts, which is exactly right,
// because the sessions it refers to are gone by then too.

const KEY = "lastAction";
const TTL_MS = 5 * 60 * 1000;

/** @typedef {{sessionId?: string, url: string, index: number, windowId: number}} ClosedTab */

async function write(action) {
  try {
    await chrome.storage.session.set({ [KEY]: action });
  } catch {
    /* no session area: undo is simply unavailable, nothing else breaks */
  }
}

/** The last undoable action, or null if there isn't one or it has gone stale. */
export async function recall(now = Date.now()) {
  try {
    const { [KEY]: action } = await chrome.storage.session.get(KEY);
    if (!action) return null;
    if (now - action.at > TTL_MS) return null;
    return action;
  } catch {
    return null;
  }
}

export async function forget() {
  try {
    await chrome.storage.session.remove(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Note tabs we just closed. chrome.tabs.remove doesn't hand back a session id, so
 * we ask the browser what it has just filed away and match on URL — keeping a queue
 * per URL, because duplicates share theirs by definition.
 *
 * Auto-closes accumulate: three tabs closed one at a time over a minute are one
 * "undo", not three offers the user has to click through.
 */
export async function rememberClosed(tabs, { kind = "close-dupes", now = Date.now() } = {}) {
  if (!tabs.length) return;
  const closed = tabs.map((t) => ({ url: t.url, index: t.index, windowId: t.windowId }));

  try {
    const recent = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    const byUrl = new Map();
    for (const entry of recent) {
      const url = entry.tab?.url;
      if (!url) continue;
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(entry.sessionId);
    }
    for (const c of closed) c.sessionId = byUrl.get(c.url)?.shift();
  } catch {
    /* no session list — the stored URL is still enough to reopen the page */
  }

  let all = closed;
  if (kind === "auto-close") {
    const prev = await recall(now);
    if (prev?.kind === "auto-close") all = [...prev.closed, ...closed];
  }

  await write({
    kind,
    at: now,
    closed: all,
    label: `${all.length} closed tab${all.length > 1 ? "s" : ""}`,
  });
}

/** Note the shelves we just took apart, from ungroupAll()'s snapshot. */
export async function rememberUngrouped(windowId, moved, now = Date.now()) {
  if (!moved.length) return;
  const shelves = new Set(moved.map((m) => m.groupId)).size;
  await write({
    kind: "ungroup",
    at: now,
    windowId,
    moved,
    label: `${shelves} shelf${shelves > 1 ? "s" : ""} taken apart`,
  });
}

async function reopen(closed) {
  let n = 0;
  for (const c of closed) {
    if (c.sessionId) {
      try {
        await chrome.sessions.restore(c.sessionId);
        n++;
        continue;
      } catch {
        /* the session expired or was already restored — fall through */
      }
    }
    // Fallback: the page comes back, its history and scroll position do not. Worse
    // than a real restore, better than the tab staying gone.
    try {
      await chrome.tabs.create({
        url: c.url,
        index: c.index,
        windowId: c.windowId,
        active: false,
      });
      n++;
    } catch {
      /* that window is gone too */
    }
  }
  return n;
}

/** Rebuild the shelves. Chrome destroyed the old group ids along with the groups,
 *  so these are new groups wearing the old names — a saved group does not come back
 *  saved. */
async function regroup(windowId, moved) {
  const byGroup = new Map();
  for (const m of moved) {
    if (!byGroup.has(m.groupId)) byGroup.set(m.groupId, []);
    byGroup.get(m.groupId).push(m);
  }

  let n = 0;
  for (const members of byGroup.values()) {
    const tabIds = [];
    for (const m of members) {
      try {
        await chrome.tabs.get(m.tabId);
        tabIds.push(m.tabId);
      } catch {
        /* closed since */
      }
    }
    if (!tabIds.length) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      const { title, color, collapsed } = members[0];
      await chrome.tabGroups.update(groupId, { title, color, collapsed });
      n += tabIds.length;
    } catch {
      /* skip this shelf, try the next */
    }
  }
  return n;
}

/** Put back whatever the last action took away. */
export async function undo(now = Date.now()) {
  const action = await recall(now);
  if (!action) return { ok: false, restored: 0 };
  // Drop it first: a half-finished undo must not be offered a second time.
  await forget();

  let restored = 0;
  if (action.closed?.length) restored += await reopen(action.closed);
  if (action.moved?.length) restored += await regroup(action.windowId, action.moved);
  return { ok: true, restored, kind: action.kind };
}
