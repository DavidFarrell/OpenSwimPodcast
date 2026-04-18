# Prototype

Claude Design handoff bundle exported 2026-04-18.

## Files

| File | Purpose |
|---|---|
| `OpenSwim Podcast.html` | Primary prototype. Inline JSX + Babel standalone. Loads fonts from `fonts/`. |
| `OpenSwim Podcast (standalone).html` | Self-contained 1.4 MB build with fonts inlined as base64. Works fully offline with no sibling files. |
| `OpenSwim Podcast-print.html` | Print-optimised variant - renders every screen stacked across landscape pages for PDF export. |
| `App.jsx`, `Atoms.jsx`, `Shell.jsx`, `ScreensA/B/C.jsx`, `data.js` | Source components that were inlined into the HTML. Kept for reference when porting to a real build. |
| `styles.css` | Source stylesheet. Already inlined into the HTML `<style>` block. |
| `fonts/` | Variable woff2 subsets (Space Grotesk, JetBrains Mono; latin + latin-ext). |
| `assets/` | SVG artwork (wordmark, device silhouette, thumb placeholder). |

## Running

Open `OpenSwim Podcast.html` in any modern browser, or serve the folder:

```
cd prototype
python3 -m http.server 8000
# then visit http://localhost:8000/OpenSwim%20Podcast.html
```

The standalone variant works by double-click alone. The non-standalone variant needs the sibling `fonts/` folder.

## Scope

Five screens: Connect, Up Next, Today, Sync (idle / running / success), Eject dialog. Tweaks panel (toolbar toggle) switches Today row-fate treatment and Sync layout. See `../design-brief.md` for the behavioural spec and `../design-system/` for the underlying tokens.
