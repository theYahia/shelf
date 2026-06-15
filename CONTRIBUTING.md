# Contributing to shelf

Small, focused project. Contributions welcome — here's the lay of the land.

## Run it locally

1. `git clone` this repo.
2. Open `brave://extensions` (or `chrome://extensions`) → enable **Developer mode**.
3. **Load unpacked** → select the repo folder.
4. Reload the extension from that page after any change. There is **no build step** —
   it's vanilla ES-module JavaScript, what you see is what runs.

## Tests

Pure logic (`lib/domain.js`, `lib/dedupe.js`, `matchRule` in `lib/grouping.js`) is
covered by unit tests on Node's built-in runner — no dependencies:

```bash
node --test tests/      # or: npm test
```

Add a test in `tests/lib.test.js` for any new pure function. Anything that calls
`chrome.*` lives in `background.js` and is verified by hand in the browser (see the
checklist in the PR template / README).

## Icons

Icons are generated, not hand-drawn — edit `scripts/make-icons.mjs` and run:

```bash
node scripts/make-icons.mjs   # or: npm run icons
```

Commit the regenerated `icons/icon*.png`. CI checks they're up to date.

## Architecture (where things go)

- `lib/grouping.js` — the shelving engine. New ways to group tabs are **strategies**:
  implement `GroupingStrategy.assign(tabs, settings) → Map<tabId, {key,title,color}>`
  and add it to `PIPELINE` (first strategy to claim a tab wins). This is where the
  planned local-LLM (Ollama) strategy will live. `computeAssignments` only feeds
  **loose** tabs to strategies, and `applyAssignments` never renames/recolours an
  existing group — shelf respects manual organisation.
- `lib/domain.js` / `lib/dedupe.js` — pure helpers (keep them browser-free, so they
  stay testable).
- `background.js` — the service worker: event wiring, the per-window serialization
  queue, debounced badge. Keep `chrome.*` calls here.
- `popup.*` / `options.*` — UI.

## Style

Match what's there: small functions, JSDoc on exports, no framework, no build.
Keep the librarian quiet — lazy, not careless.
