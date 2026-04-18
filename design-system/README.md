# OpenSwim Podcast — Design System

**Variant:** Workbench
**Palette:** Dark Coffee (#3E2723) · Tea Green (#DDF4C9) · Amber (#E8B44F)
**Fonts:** Space Grotesk (display/body) · JetBrains Mono (metadata)

A warm-analog / utilitarian design system for a single-user desktop app that
syncs Pocket Casts episodes to a Shokz OpenSwim Pro.

---

## Files

| File | Purpose |
|---|---|
| `tokens.css` | All design tokens as CSS custom properties. The single source of truth. |
| `components.css` | Component classes (`ct-*`) built on top of tokens. |
| `index.html` | Living style guide — open this to see every token and component. |
| `DECISIONS.md` | Why each choice was made, and what's still open. |
| `HANDOFF.md` | Notes for the next developer (or Claude Code). |

---

## Quick start

```html
<link rel="stylesheet" href="design-system/fonts/fonts.css">
<link rel="stylesheet" href="design-system/tokens.css">
<link rel="stylesheet" href="design-system/components.css">

<body class="openswim">
  <button class="ct-btn ct-btn--cta">Sync 7 episodes</button>
</body>
```

Fonts are self-hosted in `design-system/fonts/` (variable woff2, latin + latin-ext subsets). No external CDN needed.

The `openswim` class on `<body>` applies the base font, color, and background.

---

## Rules of the system

1. **Use tokens, not raw values.** Never write `color: #DDF4C9` — write `color: var(--fg)`. Never write `padding: 11px` — write `padding: var(--sp-3)`.
2. **Flat, not rounded.** `--radius` is `0`. Don't override it.
3. **Amber means "happening right now."** Nothing else is amber. Not hover, not selection, not info.
4. **Metadata is mono. Everything else is sans.** Durations, file sizes, timestamps, counts, log output → JetBrains Mono. Titles, show names, buttons → Space Grotesk.
5. **Show names are ALL-CAPS.** Episode titles are Sentence case. This is how the eye separates them.
6. **No shadows on the coffee surface.** Layering uses hairline rules (`--rule`) or the deeper coffee tiers (`--bg-inset`).
7. **Dark mode only.** No light variant. This app is used at 6am.

---

## Token cheat sheet

```
Surface:  --bg  --bg-inset
Ink:      --fg  --fg-dim  --fg-muted
Accent:   --accent (amber)  --destructive (terracotta, rare)
Rules:    --rule  --rule-strong
Type:     --font-sans  --font-mono
          --fs-caption (10) --fs-meta (11) --fs-body (13)
          --fs-title (15)   --fs-subhead (22) --fs-hero (44)
Space:    --sp-1..9  (4 8 12 16 20 24 32 48 64)
Motion:   --dur-fast (100) --dur-base (160) --dur-slow (280)
```

---

## Components available

`.ct-btn` (`--primary | --secondary | --cta | --ghost | --destructive`)
`.ct-tag` (`--active | --on-device | --error`)
`.ct-input`, `.ct-input-group`, `.ct-kbd`
`.ct-toggle` (pair with `aria-checked`)
`.ct-row` + children (`.ct-row__n`, `__thumb`, `__main`, `__title`, `__show`, `__dur`, `__size`, `__dot`)
`.ct-progress` + `.ct-progress__fill`
`.ct-window` + `.ct-window__chrome`, `__dots`, `__title`, `__body`
`.ct-toolbar`
`.ct-log` + `.ct-log__line--done|active|pending`
Typography: `.ct-hero`, `.ct-subhead`, `.ct-title`, `.ct-body`, `.ct-label`, `.ct-meta`

Open `index.html` to see every one rendered.
