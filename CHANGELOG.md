# Changelog

## 0.9.0

The release where the librarian actually starts shelving.

### ⚠️ Settings move off browser sync

Settings used to live in `chrome.storage.sync`, which meant your rules — including
any internal hostnames in them — travelled through Google's servers under your
browser account. That contradicted the "no cloud" on the tin, so they now live in
`chrome.storage.local`.

Your existing settings are copied across automatically the first time 0.9 runs.
The old sync copy is left untouched for a couple of releases in case you downgrade.
**Settings no longer follow you between machines** — use Export / Import on the
options page instead.

### Fixed

- **Automatic shelving created nothing.** Grouping a tab you'd just left fed the
  engine a single tab, and the "only group a site with 2+ tabs" threshold then
  rejected it — every time. New shelves only ever appeared via *Shelve now*. The
  threshold now asks what it always meant to: how many tabs of that site are open in
  the window.
- **Waking up cost one storage read and one group query per tab.** Now one pass.
- **Different sites could share a shelf.** Shelves were bucketed by their display
  title, so `example.com` and `example.org` — both "Example" — were merged. They're
  keyed by domain now, and an existing shelf is recognised by what's in it, which
  also means a group you renamed by hand keeps receiving its tabs.
- **Colours were not deterministic**, despite the README. A shelf's colour is now
  derived from its domain and doesn't change between sessions.
- **Auto-close could close a page you were using.** Hash routes (`app/#/inbox` vs
  `app/#/billing`) counted as duplicates. Auto-close now requires an exact address
  match, whatever the looser badge settings say.
- **Two `chrome://newtab` counted as duplicates** and could be auto-closed.
- **A pinned tab could be closed** as a duplicate. It's now always the copy that's
  kept, and the badge counts only what the button can actually close.
- **A rule of `co` matched every `.com`.** Rules now match a host, a whole name part,
  or a path — never a bare substring of the address.
- **Exceptions did nothing for subdomains** (`mail.google.com` under an exception of
  `google.com`), and a rule could override one. Exceptions now win, first.
- **The badge showed one window's count on every window.**
- **One stale tab id sank the whole "Close duplicates"** — and left the popup hanging
  with no reply at all.
- **A tab dragged to another window** could be hauled back to the one it left.
- **Corrupt stored settings killed grouping silently.** Everything read from storage
  is now repaired on the way in.
- **A refused settings write showed nothing at all** — no tick, no reason.
- `localhost:3000` and `localhost:8080` no longer share a shelf; nor do
  `alice.github.io` and `bob.github.io`.

### Added

- **Undo** in the popup for anything closed or taken apart, for five minutes.
- **Find a tab** — search the popup, jump to it, and its shelf opens on the way.
- **Unload collapsed shelves** (opt-in) — give the memory back for tabs you've folded
  away. Never the tab you're on, a pinned one, one playing audio, or an exception.
- **Strays swept to the end** — lone tabs no longer sit wedged between shelves. Order
  among them is kept, the tab you're on stays put until you leave it, and pinned tabs
  aren't touched. Switch it off under Shelving if you order tabs by hand.
- **Pause** — an hour where shelf keeps its hands off.
- **Export / Import / Reset** settings as JSON.
- **A first run that asks.** Installing used to rearrange every window on the spot.
  It now shows what it would do and waits.
- Dark mode, matching whatever the browser is set to.
- Tests for everything that talks to the browser, via a small in-memory fake.

## 0.5.1

Initial public shape: domain grouping, rules, Focus Mode, duplicate detection.
