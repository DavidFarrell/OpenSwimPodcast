# Decisions log

Every decision below was locked in during the design-system exploration. Open
questions at the bottom are things to settle as the app gets built.

## Locked

### Palette
- **Dark Coffee #3E2723** is the app background.
- **Tea Green #DDF4C9** is the foreground.
- **Amber #E8B44F** is the only third color, reserved for active/in-progress state.
- **Terracotta #C96F4A** is reserved for destructive/error. Used sparingly — most of the time state is shown by weight/opacity, not color.

### Typography
- **Space Grotesk** for all display, body, and UI chrome.
- **JetBrains Mono** for metadata only — durations, sizes, timestamps, counts, log lines.
- Six sizes: 10 / 11 / 13 / 15 / 22 / 44.
- ALL-CAPS mono for show names and screen labels. Sentence case for episode titles.

### Shape
- **Corner radius = 0.** Flat rectangles everywhere. This is the single biggest aesthetic commitment — it's what makes the system feel like a workbench, not a library app.
- Hairline rules (`rgba(tea, 0.12)`) for layering. No drop shadows.
- Two coffee tiers: `coffee` for primary surface, `coffee-deep` for inset/inputs.

### Density
- Dense list rows (~44px target, 14+ rows visible in 500px).
- Thumbs are 28px striped neutral blocks — they establish row height but stay out of the way.
- On the Today / Device preview screen, rows can breathe more since there are only ~7 of them.

### Accent behavior
- Amber appears in exactly three places: the active-row dot, the progress bar fill, and the `SYNC` CTA button. Nowhere else.
- Hover is a subtle `tea-ghost` background shift, never a color change.

### Motion
- 100/160/280ms three-tier scale.
- Default `ease` is `cubic-bezier(0.2, 0.8, 0.2, 1)` — snappy but not jarring.
- Sync screen is the one place we let motion do storytelling (files animating toward a device silhouette). Everywhere else: fast, boring, correct.

### Voice
- Concierge for headlines ("Ready for your swim · 7 episodes").
- Terminal for metadata ("163.4MB · ≈ 14 min at 1.8MB/s").
- Mono carries precision; sans carries warmth.

---

## Open questions (resolve as you build)

1. **Artwork on list rows** — Current: striped neutral thumbs. Option: pull real Pocket Casts cover art on the Today/Device screen (moment of delight) but keep neutral thumbs in the 1000-item Up Next (speed). Recommended.
2. **Filter UI** — Not designed yet. Likely a slide-in panel from the right, using the same `.ct-row` pattern for multi-select.
3. **Error states** — The terracotta color exists but no error component has been drawn. First error to design: "transfer failed — device not mounted."
4. **Empty states** — After a successful sync, what does "Today" look like when there's nothing queued yet? Suggested: a one-liner in `--fg-muted` and a big `ct-btn--cta` to pull from Up Next.
5. **Keyboard shortcuts** — `⌘K` placeholder exists on search. Full shortcut sheet (j/k to navigate, space to select, ⏎ to sync) not yet defined.
6. **Icons** — System uses none right now; it reads fine. First icons that might earn their place: trash (remove from queue), drag handle, search magnifier. Style would be 1.25px stroke on a 16×16 grid.

---

## What the variants *didn't* choose (for posterity)

- **Rounded corners** (variant A — Cinema). Rejected because flat reads more like a pro tool and matches the "workbench" metaphor.
- **No accent / strict two-tone** (variant C — Plaintext). Rejected because finding "the thing happening now" in a log of 1000 items is meaningfully faster with a single hot color.
- **Duotone artwork tiles** (variant A). Rejected for the main list because ~1000 tinted tiles on a dark-coffee background is visually busy; neutral thumbs let titles do the work.
