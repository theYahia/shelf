// fake-chrome.js — a small in-memory browser, so the parts of shelf that call
// chrome.* are testable instead of "verified by hand". No dependencies.
//
// Deliberately NOT named *.test.js: node --test would try to run it.
//
//   const world = makeWorld({ tabs: [{ id: 1, url: "https://github.com" }] });
//   globalThis.chrome = makeChrome(world);        // before importing background.js
//   const bg = await import("../background.js?t=1");
//   await world.fire("tabs.onActivated", { tabId: 1, windowId: 1 });
//   await bg.idle();
//
// It models only what shelf actually uses, and only the behaviours shelf can trip
// over — a batch tabs.group() rejecting whole for one dead id, an empty group
// disappearing by itself. Anything Chrome does that we don't reproduce here is on
// the manual checklist, not silently assumed to work.

const TAB_GROUP_ID_NONE = -1;

/** Build the world. Tabs get sensible defaults; pass overrides per tab. */
export function makeWorld(init = {}) {
  const world = {
    windows: init.windows || [{ id: 1, focused: true }],
    tabs: (init.tabs || []).map((t, i) => ({
      id: i + 1,
      windowId: 1,
      index: i,
      groupId: TAB_GROUP_ID_NONE,
      pinned: false,
      active: false,
      discarded: false,
      audible: false,
      status: "complete",
      title: "",
      url: "",
      ...t,
    })),
    groups: (init.groups || []).map((g) => ({
      windowId: 1,
      title: "",
      color: "grey",
      collapsed: false,
      ...g,
    })),
    storage: {
      local: { ...(init.local || {}) },
      sync: { ...(init.sync || {}) },
      session: {},
    },
    closedStack: [], // most recent first, like chrome.sessions
    badge: { text: "", color: "" },
    listeners: new Map(),
    calls: {},
    nextGroupId: 100,
    nextSessionId: 1,
    nextTabId: 1000,
  };

  /** Dispatch an event to whatever background.js registered, and wait for it. */
  world.fire = async (name, ...args) => {
    for (const fn of world.listeners.get(name) || []) await fn(...args);
  };
  world.groupsIn = (windowId = 1) => world.groups.filter((g) => g.windowId === windowId);
  world.tabsIn = (windowId = 1) => world.tabs.filter((t) => t.windowId === windowId);
  /** The tabs of one group, in id order — handy for "did they all land here?". */
  world.groupTabs = (groupId) =>
    world.tabs.filter((t) => t.groupId === groupId).sort((a, b) => a.id - b.id);

  return world;
}

/** Chrome drops a group as soon as its last tab leaves it. */
function pruneEmptyGroups(world) {
  const live = new Set(world.tabs.map((t) => t.groupId));
  world.groups = world.groups.filter((g) => live.has(g.id));
}

export function makeChrome(world) {
  const track = (name) => {
    world.calls[name] = (world.calls[name] || 0) + 1;
  };
  const clone = (o) => ({ ...o });
  const asArray = (x) => (Array.isArray(x) ? x : [x]);

  const event = (name) => ({
    addListener(fn) {
      if (!world.listeners.has(name)) world.listeners.set(name, []);
      world.listeners.get(name).push(fn);
    },
    removeListener(fn) {
      const fns = world.listeners.get(name) || [];
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    },
  });

  const mustTab = (id) => {
    const t = world.tabs.find((x) => x.id === id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    return t;
  };

  const area = (name) => ({
    async get(keys) {
      track(`storage.${name}.get`);
      const store = world.storage[name];
      if (keys == null) return { ...store };
      if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
      }
      const out = { ...keys }; // an object argument supplies the defaults
      for (const k of Object.keys(keys)) if (k in store) out[k] = store[k];
      return out;
    },
    async set(patch) {
      track(`storage.${name}.set`);
      Object.assign(world.storage[name], patch);
    },
    async remove(keys) {
      for (const k of asArray(keys)) delete world.storage[name][k];
    },
    async clear() {
      world.storage[name] = {};
    },
  });

  return {
    tabs: {
      TAB_ID_NONE: -1,

      async query(q = {}) {
        track("tabs.query");
        return world.tabs
          .filter((t) => q.windowId === undefined || t.windowId === q.windowId)
          .filter((t) => q.pinned === undefined || t.pinned === q.pinned)
          .filter((t) => q.active === undefined || !!t.active === q.active)
          .map(clone);
      },

      async get(id) {
        track("tabs.get");
        return clone(mustTab(id));
      },

      async create({ url = "", index, windowId = 1, active = true } = {}) {
        track("tabs.create");
        if (!world.windows.some((w) => w.id === windowId)) {
          throw new Error(`No window with id: ${windowId}.`);
        }
        const tab = {
          id: world.nextTabId++,
          windowId,
          index: index ?? world.tabs.length,
          groupId: TAB_GROUP_ID_NONE,
          pinned: false,
          active,
          discarded: false,
          audible: false,
          status: "complete",
          title: "",
          url,
        };
        world.tabs.push(tab);
        return clone(tab);
      },

      async group({ tabIds, groupId, createProperties }) {
        track("tabs.group");
        // One dead or pinned id rejects the whole call — that is Chrome's actual
        // behaviour, and the reason shelf can lose a whole shelf during a restore.
        const tabs = asArray(tabIds).map((id) => {
          const t = mustTab(id);
          if (t.pinned) throw new Error("Pinned tabs cannot be grouped.");
          return t;
        });
        let gid = groupId;
        if (gid === undefined) {
          gid = world.nextGroupId++;
          world.groups.push({
            id: gid,
            windowId: createProperties?.windowId ?? tabs[0].windowId,
            title: "",
            color: "grey",
            collapsed: false,
          });
        }
        const g = world.groups.find((x) => x.id === gid);
        if (!g) throw new Error(`No group with id: ${gid}.`);
        for (const t of tabs) {
          t.groupId = gid;
          t.windowId = g.windowId; // grouping moves a tab into the group's window
        }
        pruneEmptyGroups(world);
        return gid;
      },

      async ungroup(tabIds) {
        track("tabs.ungroup");
        const tabs = asArray(tabIds).map(mustTab);
        for (const t of tabs) t.groupId = TAB_GROUP_ID_NONE;
        pruneEmptyGroups(world);
      },

      async remove(tabIds) {
        track("tabs.remove");
        const ids = asArray(tabIds);
        for (const id of ids) mustTab(id); // batch rejects whole if any id is stale
        for (const id of ids) {
          const t = mustTab(id);
          world.closedStack.unshift({
            sessionId: String(world.nextSessionId++),
            tab: clone(t),
          });
        }
        world.tabs = world.tabs.filter((t) => !ids.includes(t.id));
        pruneEmptyGroups(world);
      },

      async update(id, props) {
        track("tabs.update");
        const t = mustTab(id);
        if (props.active) {
          for (const o of world.tabs) if (o.windowId === t.windowId) o.active = o.id === id;
        }
        Object.assign(t, props);
        return clone(t);
      },

      async move(tabIds, { index, windowId } = {}) {
        track("tabs.move");
        const ids = asArray(tabIds);
        const moving = ids.map(mustTab);
        const win = windowId ?? moving[0].windowId;
        // Chrome renumbers the whole strip on a move; model that rather than just
        // stamping an index, or an ordering test proves nothing.
        const rest = world.tabs
          .filter((t) => t.windowId === win && !ids.includes(t.id))
          .sort((a, b) => a.index - b.index);
        const at = index < 0 || index > rest.length ? rest.length : index;
        [...rest.slice(0, at), ...moving, ...rest.slice(at)].forEach((t, i) => {
          t.index = i;
          t.windowId = win;
        });
        return moving.map(clone);
      },

      async discard(id) {
        track("tabs.discard");
        const t = mustTab(id);
        if (t.active) throw new Error("Cannot discard the active tab.");
        t.discarded = true;
        return clone(t);
      },

      onUpdated: event("tabs.onUpdated"),
      onRemoved: event("tabs.onRemoved"),
      onActivated: event("tabs.onActivated"),
      onAttached: event("tabs.onAttached"),
      onDetached: event("tabs.onDetached"),
      onCreated: event("tabs.onCreated"),
      onMoved: event("tabs.onMoved"),
    },

    tabGroups: {
      TAB_GROUP_ID_NONE,
      async query(q = {}) {
        track("tabGroups.query");
        return world.groups
          .filter((g) => q.windowId === undefined || g.windowId === q.windowId)
          .map(clone);
      },
      async update(id, props) {
        track("tabGroups.update");
        const g = world.groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        Object.assign(g, props);
        return clone(g);
      },
      onUpdated: event("tabGroups.onUpdated"),
      onRemoved: event("tabGroups.onRemoved"),
    },

    storage: {
      local: area("local"),
      sync: area("sync"),
      session: area("session"),
      onChanged: event("storage.onChanged"),
    },

    windows: {
      WINDOW_ID_NONE: -1,
      async getAll() {
        track("windows.getAll");
        return world.windows.map(clone);
      },
      async getCurrent() {
        track("windows.getCurrent");
        return clone(world.windows.find((w) => w.focused) || world.windows[0]);
      },
      async getLastFocused() {
        track("windows.getLastFocused");
        return clone(world.windows.find((w) => w.focused) || world.windows[0]);
      },
      async update(id, props) {
        const w = world.windows.find((x) => x.id === id);
        if (!w) throw new Error(`No window with id: ${id}.`);
        if (props.focused) for (const o of world.windows) o.focused = o.id === id;
        return clone(w);
      },
      onRemoved: event("windows.onRemoved"),
      onFocusChanged: event("windows.onFocusChanged"),
    },

    action: {
      async setBadgeText({ text }) {
        track("action.setBadgeText");
        world.badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        world.badge.color = color;
      },
    },

    sessions: {
      async getRecentlyClosed({ maxResults = 25 } = {}) {
        track("sessions.getRecentlyClosed");
        return world.closedStack.slice(0, maxResults).map((e) => ({
          sessionId: e.sessionId,
          tab: clone(e.tab),
        }));
      },
      async restore(sessionId) {
        track("sessions.restore");
        const i = world.closedStack.findIndex((e) => e.sessionId === sessionId);
        if (i < 0) throw new Error(`Invalid session id: ${sessionId}.`);
        const [entry] = world.closedStack.splice(i, 1);
        const tab = { ...entry.tab, groupId: TAB_GROUP_ID_NONE };
        world.tabs.push(tab);
        return { tab: clone(tab) };
      },
    },

    alarms: {
      async create(name, info) {
        track("alarms.create");
        world.alarm = { name, info };
      },
      async clear() {},
      onAlarm: event("alarms.onAlarm"),
    },

    commands: { onCommand: event("commands.onCommand") },

    runtime: {
      openOptionsPage() {},
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: event("runtime.onMessage"),
      onInstalled: event("runtime.onInstalled"),
      sendMessage(msg) {
        track("runtime.sendMessage");
        const fns = world.listeners.get("runtime.onMessage") || [];
        return new Promise((resolve, reject) => {
          if (!fns.length) return reject(new Error("Could not establish connection."));
          let settled = false;
          const respond = (res) => {
            if (settled) return;
            settled = true;
            resolve(res);
          };
          for (const fn of fns) fn(msg, { id: "test" }, respond);
        });
      },
    },
  };
}
