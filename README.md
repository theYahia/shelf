<h1 align="center">📚 shelf</h1>

<p align="center"><em>He says nothing. He shelves them.</em></p>

<p align="center">
  <img src="https://github.com/theYahia/shelf/actions/workflows/test.yml/badge.svg" alt="tests" />
  <img src="https://img.shields.io/badge/manifest-v3-7a4a24" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/license-MIT-7a4a24" alt="MIT" />
  <img src="https://img.shields.io/badge/works%20in-Brave%20%C2%B7%20Chrome%20%C2%B7%20Edge-7a4a24" alt="Brave / Chrome / Edge" />
  <img src="https://img.shields.io/badge/build-none%20(vanilla%20JS)-7a4a24" alt="No build" />
</p>

---

<p align="center">
  <!-- generated animation (scripts/make-demo.mjs); swap for a real screen-recorded GIF if you make one -->
  <img src="assets/demo.png" width="460" alt="before: one screaming row of grey tabs — after: tidy coloured shelves, then collapsed" />
</p>

<p align="center"><strong>Your tab bar is a screaming row. He shelves it — quietly.</strong></p>

You know him. The old librarian. Glasses on a chain, finger to his lips, has known where every book lives since before you were born. You drop forty-seven open tabs on his desk in one screaming row. He says nothing. He shelves them.

**shelf** puts him inside your browser.

## Before / after

```
before  ▸ github · github · youtube · docs · jira · github · youtube · docs · …
                         (one long screaming row)

after   ▸ 🔵 Github (3)   🔴 Youtube (2)   🟢 Docs (2)   🟡 Jira
                  collapsed. quiet. shelved.
```

Every tab finds its shelf, by domain or by your own rules. Switch shelves and the
rest fold shut behind you (Focus Mode). No cloud, no account, no API key.

## Features

- **Auto-group by domain** — `github.com → Github`, deterministic colour per site, ccSLD-aware (`example.co.uk`, not `co.uk`), and hosting-aware (`alice.github.io` and `bob.github.io` are two different people).
- **Focus Mode** — collapse every group except the one you're working in.
- **Strays to the end** — whatever stays loose is swept to the back of the strip, so the shelves stand together instead of being broken up by lone tabs.
- **Custom rules** — send `cnn.com` and `bbc.com` to one **News** shelf; rules override domains.
- **Find a tab** — type in the popup, jump straight to it. The shelf opens on the way.
- **Duplicate detection** — badge counts duplicate tabs; close them all in one click, or auto-close on open.
- **Undo** — one click puts back whatever he last closed or took apart. Five-minute memory.
- **Give memory back** — optionally unload the tabs in a shelf once you've folded it shut.
- **Pause** — an hour where he keeps his hands off entirely.
- **Exceptions** — domains the librarian never touches, subdomains included.
- **Merge subdomains**, minimum-tabs-to-shelf, collapse-by-size — all optional.
- **Zero telemetry, zero network, no account.** Settings are stored on this machine
  and nowhere else — not even in browser sync. Export/Import moves them by hand.

## Install (Load unpacked)

1. Clone or download this folder.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.
5. He opens a page showing what he *would* do, and waits for you to say yes.

No build step. It's vanilla JavaScript — what you see is what runs.

## How he works

Before shelving a tab, the librarian asks, in order:

```
1. Is it a real page?        → no (chrome://, brave://): leave it alone
2. Does a rule claim it?     → yes: that shelf wins
3. Otherwise:                → shelve by domain, coloured by domain
```

Lazy, not careless: pinned tabs are never touched, exceptions are honoured before any
rule gets a say, and he never sends a single URL anywhere.

He shelves a tab **when you leave it**, never while you're reading it — so opening a
link never yanks the current tab out from under you into a faraway group. A site gets
a shelf once you have two of its tabs open in that window; a shelf that already exists
takes new arrivals immediately.

### About closing things

Auto-close only ever closes an **exact** address match — `app/#/inbox` and
`app/#/billing` are two pages of one app, not two copies of one page. The badge and
the **Close duplicates** button use your looser settings instead, because there a
human sees the list first. Either way, **Undo** in the popup puts them back.

## Shortcuts

Two optional keyboard shortcuts (defaults below — rebind at `brave://extensions/shortcuts`):

- **Shelve now** — `Ctrl+Shift+U`
- **Hush** (collapse all groups) — `Ctrl+Shift+E`

## Settings

Right-click the icon → **Options**, or the **Settings →** link in the popup. Toggle
Focus Mode, merge-subdomains, thresholds, edit rules and exceptions, tune duplicate
matching.

### He respects what you do by hand

shelf only shelves **loose** tabs (ones not already in a group). Groups you make,
name, or recolour yourself are never moved, renamed, or re-collapsed. Want a fixed
**name and colour** for a site? Add a **rule** (`domain → name → colour`) — shelf keeps
it stable. A manual rename *without* a rule isn't tracked, so new tabs of that domain
may start a fresh group; use a rule if you want them to keep merging.

## Roadmap

- **Firefox.** `tabGroups` has landed in the WebExtensions API, so the blocker is
  gone. `lib/` is already browser-agnostic; what differs is the manifest
  (`background.scripts` instead of a service worker, plus a `gecko` id).
- **v2 — the librarian learns to read.** Optional semantic grouping by *topic* (not
  just domain) via a **local LLM through Ollama** — fully private, nothing leaves your
  machine. A strategy is just `(tabs, settings) => Map<tabId, Shelf>` in
  `lib/grouping.js`, so this drops into `PIPELINE` as one more entry.
- A side panel, for people whose shelves outgrow a 320px popup.

## License

[MIT](LICENSE). The shortest license that holds.
