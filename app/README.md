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
  Atoms.jsx         Btn, Kbd, Progress, CoverArt, MountPill, DragHandle
  Shell.jsx         Window chrome, Sidebar, Toolbar
  LoginScreen.jsx   Pocket Casts cookie paste + fake connect
  UpNextScreen.jsx  filter + tap-to-queue with order pill
  TodayScreen.jsx   drag-to-reorder, rename/new/remove fates
  SyncScreen.jsx    5-stage stepper + log, transforms to Success on done
  data.js           curated sample upNext (mock fallback)
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

## Implementation status

The Electron backend is fully implemented (`electron/`):

- `pocketcasts.cjs` / `pocketcastsApi.cjs` - real email/password auth to a JWT, encrypted at rest via Electron `safeStorage`.
- `downloader.cjs` - streaming episode download to a local cache, Range-resume, progress events.
- `device.cjs` - OpenSwim Pro detection on `/Volumes`, capacity readout, claim/eject.
- `converter.cjs` - video to 128 kbps mono mp3 via bundled `ffmpeg-static`.
- `sync.cjs` - the real staged pipeline (finalise -> delete -> convert -> transfer -> verify) with an on-device manifest for accurate diffs.

The renderer reaches all of this through `window.openswim` (`preload.cjs` / `ipc.cjs`). When that bridge is absent (running the renderer as plain Vite via `npm run dev`), the app falls back to the hard-coded sample data in `src/data.js` so the UI can be worked on without a device or account. `npm run electron:dev` runs the fully wired app.

Still on the roadmap (see `PLAN.md`): SQLite catalogue (deferred - localStorage plus the on-device manifest currently suffice), settings/error-UI/logs, packaging/signing, and the playback-progress sync-back stretch.
