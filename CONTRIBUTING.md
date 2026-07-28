# Contributing to shelf

Small, focused project. Contributions welcome — here's the lay of the land.

## Run it locally

1. `git clone` this repo.
2. Open `brave://extensions` (or `chrome://extensions`) → enable **Developer mode**.
3. **Load unpacked** → select the repo folder.
4. Reload the extension from that page after any change. There is **no build step** —
   it's vanilla ES-module JavaScript, what you see is what runs.

## Tests

Everything is covered by unit tests on Node's built-in runner — no dependencies:

```bash
node --test      # or: npm test
```

Add a test in `tests/lib.test.js` for any new pure function.

Code that calls `chrome.*` is covered too: `tests/fake-chrome.js` is a small in-memory
browser (windows, tabs, groups, storage) with no dependencies. Install it on
`globalThis.chrome` **before** importing `background.js` — that module registers its
listeners at import time — then drive it through `world.fire(...)`:

```js
const world = makeWorld({ tabs: [...] });
globalThis.chrome = makeChrome(world);
const bg = await import("../background.js");
await world.fire("tabs.onActivated", { tabId: 2, windowId: 1 });
await bg.idle();                     // wait for the per-window queue to drain
assert.equal(world.groups().length, 1);
```

`world.calls` counts API calls, which is how the "one pass, not one per tab" promise
in `shelve()` stays honest. Only the truly untestable bits — how Chrome itself behaves
on discard, session restore, or a dragged tab — are verified by hand.

## Icons

Icons are generated, not hand-drawn — edit `scripts/make-icons.mjs` and run:

```bash
node scripts/make-icons.mjs   # or: npm run icons
```

Commit the regenerated `icons/icon*.png`. CI checks they're up to date.

## Architecture (where things go)

- `lib/grouping.js` — the shelving engine. A **strategy** is a plain function
  `(tabs, settings) → Map<tabId, {key,title,color}>`; add it to `PIPELINE` and the
  first strategy to claim a tab wins. This is where the planned local-LLM (Ollama)
  strategy will live. `assignAll` runs the pipeline over every tab (exceptions are
  filtered out first, before any strategy sees them); `computeAssignments` is the
  same thing narrowed to **loose** tabs. `applyAssignments` finds a shelf's existing
  group by *what's in it* — the key most of its tabs share — because `chrome.tabGroups`
  gives us nowhere to store our own id. It never renames or recolours a group that
  already exists: shelf respects manual organisation.
- `lib/domain.js` / `lib/dedupe.js` — pure helpers (keep them browser-free, so they
  stay testable).
- `background.js` — the service worker: event wiring, the per-window serialization
  queue, debounced badge. Keep `chrome.*` calls here.
- `popup.*` / `options.*` — UI.

## Style

Match what's there: small functions, JSDoc on exports, no framework, no build.
Keep the librarian quiet — lazy, not careless.
