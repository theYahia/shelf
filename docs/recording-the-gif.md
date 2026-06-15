# Recording a real demo GIF

The README ships a generated animation (`assets/demo.png`, built by
`scripts/make-demo.mjs`). A real screen recording of the extension in action is more
convincing — here's how to make one and swap it in.

## Record (Windows: ScreenToGif — free)

1. Install **ScreenToGif** (https://www.screentogif.com/) — open source, no account.
2. Open a browser window with **12+ tabs in a chaotic single row** (mix of domains,
   a couple of duplicates).
3. Start the recorder over the tab strip (vertical-tabs sidebar reads especially well).
4. Click the 📚 **shelf** icon → **Shelve now**. Watch the tabs sort onto coloured
   shelves. Then click **Hush** to collapse them.
5. Stop after ~5 seconds. Trim to just the sort+hush moment.

## Polish & swap in

- Keep it short (≤6s) and loop it. Target width ~460–520px so it sits inline.
- Export as `assets/demo.gif`.
- In `README.md`, point the demo `<img>` at `assets/demo.gif` instead of
  `assets/demo.png`.

That's it — the generated APNG stays as the zero-dependency fallback.
