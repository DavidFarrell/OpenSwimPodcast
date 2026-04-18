# app

Vite + React port of the Claude Design handoff prototype in `../prototype/`.

## Dev

```
npm install
npm run dev
```

Opens on `http://localhost:5173` with HMR.

## Build

```
npm run build
npm run preview
```

## Structure

```
src/
  main.jsx          mount + styles
  App.jsx           route + global state (connected, selected, order, mount)
  Atoms.jsx         Btn, Kbd, Tag, Toggle, Progress, CoverArt, MountPill, DragHandle
  Shell.jsx         Window chrome, Sidebar, Toolbar
  LoginScreen.jsx   Pocket Casts cookie paste + fake connect
  UpNextScreen.jsx  filter + tap-to-queue with order pill
  TodayScreen.jsx   drag-to-reorder, rename/new/remove fates
  SyncScreen.jsx    5-stage stepper + log, transforms to Success on done
  data.js           curated sample upNext + onDevice
  styles.css        tokens + components (from design-system)
public/
  fonts/            self-hosted Space Grotesk + JetBrains Mono (variable, latin + latin-ext)
  assets/           svg marks
```

## Design decisions from the prototype chat

- Row-fate treatment = **tag** (RENAME / NEW chips + filename).
- Sync layout = **stages** stepper on the left, streaming log on the right.
- Video always converts to MP3 - no user toggle.
- Drag-to-reorder on Today. No up/down arrows.
- Sync tab opened via the sidebar is idle (requires START SYNC). Opened via the Today CTA it auto-runs.
- Fixed 1120×720 window with scrollable middle; sidebar + mount pill are pinned.

## What's not wired yet

Everything below the UI layer is mock. No Pocket Casts integration, no USB device watcher, no ffmpeg conversion, no actual file writes. Data is hard-coded in `src/data.js`; the sync stepper animates on a `setInterval` rather than real work.
