# Handoff — OpenSwim Podcast

For whoever (or whichever Claude) picks this up next.

## What this is

A personal desktop app that:
1. Authenticates to Pocket Casts using a stored cookie (the user already has this working locally).
2. Fetches the current **Up Next** playlist (~1000 items, mixed audio/video).
3. Lets the user pick episodes for today's swim.
4. Downloads the selected episodes and transfers them via USB-MTP to a Shokz OpenSwim Pro.
5. **Renames the files with a numeric prefix** so the device plays them in the user's chosen order.

## What's in this repo right now

- `design-system/` — tokens, components, style guide, decisions. **Start here.**
- `inspo/` — the original color-palette reference.
- `Design System.html` — a design-canvas exploration showing how we got to Workbench (the chosen variant). Optional reading.

## What to build next

Suggested order:

1. **Shell + routing.** One-window macOS-style app. Three routes: `login`, `up-next`, `today`, `syncing`.
2. **Login screen.** Paste-cookie field + "Connect" button. Stash the cookie securely; don't show it again after first connect.
3. **Up Next list.** The big one. Virtualized list (react-window or similar — 1000 rows un-virtualized will feel bad). Each row = `.ct-row`. Multi-select → add to Today. Filter by show, status (downloaded / on device), duration.
4. **Today panel.** Ordered list of selected episodes. Drag-to-reorder (dnd-kit is fine). Shows total time + total MB. Shows the filename each episode *will* become after rename (`01_the-daily.mp3`, `02_99pi.mp3`, etc. — the mono metadata row is where this lives).
5. **Sync flow.** Three phases — download, rename, transfer. Use `.ct-log` for per-file status, `.ct-progress` for the aggregate bar. One moment of animated delight when all 7 are on the device.
6. **Edge cases.** Device not mounted. Download failed. Token expired. Space on device.

## Technical notes from the user's description

- A working **local method** to authenticate to Pocket Casts via cookie already exists — reuse that, don't reinvent.
- Target device is **Shokz OpenSwim Pro**, mounts as MTP on macOS. Swim-waterproof, no native podcast support — that's the whole reason this app exists.
- Video episodes should be **transcoded to audio** before transfer (there's a setting for this in the mocks — `Audio from video` toggle).
- Filename format: `NN_show-slug.mp3` so the device's alphabetical playback matches the user's drag-ordered queue.

## Using the design system

```html
<!-- In the app's root index.html -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="design-system/tokens.css">
<link rel="stylesheet" href="design-system/components.css">
<body class="openswim">…</body>
```

Every button, row, progress bar, window chrome, toggle, and tag is ready to use as CSS classes. If you're in React, you can trivially wrap them as components — nothing is JS-ified yet because the styles are the contract; the JS can be whatever fits your stack (React, Solid, vanilla — the CSS doesn't care).

## Rules that matter

Please don't:
- Add colors outside the token file.
- Add rounded corners.
- Put amber on anything that isn't actively happening right now.
- Use shadows.
- Use Inter, Roboto, or any of the boring defaults.

See `DECISIONS.md` for the reasoning behind each.

## Open design questions

Listed at the bottom of `DECISIONS.md`. TL;DR: error states, empty states, iconography, and whether to pull real cover art on the Today screen are all still to design. Ask (or decide and document).
