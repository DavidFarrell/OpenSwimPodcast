# OpenSwim Podcast · Build-out Plan

The mockup covers the whole user journey. Each screen currently lies about what it does. Below is the full list of features to replace mock with real, roughly in the order we should tackle them. Each entry has: what it does, how it should work, what to explore before coding, tests to write.

Core principle: **explore before implementing**. For each feature, first prove the primitive works (one curl, one ffmpeg invocation, one `fs.copyFile`) in a notebook/script before wiring it into the app.

---

## 1. Pocket Casts authentication

**Why first**: everything else depends on real episode data.

**What**: replace the fake "session cookie" LoginScreen with real email+password auth → JWT token → refresh flow.

**Approach**:
- Pocket Casts has an unofficial but stable HTTP API. `POST https://api.pocketcasts.com/user/login` with `{email, password, scope:"webplayer"}` returns `{token}`.
- Auth lives in the Electron **main process** (renderer is sandboxed, CORS blocks direct calls anyway). Expose via `contextBridge`:
  ```js
  openswim.pocketcasts.login(email, password) -> {ok, error?}
  openswim.pocketcasts.isAuthed() -> bool
  openswim.pocketcasts.logout()
  ```
- Token stored with `safeStorage.encryptString` in a JSON at `app.getPath('userData')/auth.json`. Check `safeStorage.isEncryptionAvailable()` at startup.
- Login screen needs two fields now (email + password), not one cookie field.

**Explore first**:
- `curl -sS -X POST https://api.pocketcasts.com/user/login -H 'Content-Type: application/json' -d '{"email":"...","password":"...","scope":"webplayer"}'` - confirm response shape.
- Check token expiry - do we need refresh or is it long-lived?

**Tests**:
- Unit: encrypt → decrypt round-trip, token persistence across restarts (mocked userData dir).
- Integration (manual, gated on env var): real login → real `/user/login` → token present.
- UI: error states (wrong password, offline, server 500).

---

## 2. Up Next feed

**Why second**: this is the "prove we have real data" moment. Once the Up Next screen shows actual user episodes, the app stops being a demo.

**What**: replace `data.js#upNext` with a live fetch.

**Approach**:
- `POST https://api.pocketcasts.com/up_next/list` with the bearer token. Returns `{episodes:[{uuid, title, podcastTitle, duration, fileType, size, url, ...}]}`.
- Main process fetch, renderer gets clean JSON via IPC `openswim.pocketcasts.getUpNext()`.
- Write a thin adapter that maps Pocket Casts episode → our `{id, title, show, dur, durMin, size, sizeMB, kind}` shape. `kind` comes from `fileType` (audio/mp4). Keep the PC `uuid` on the object - we need it for media URLs later.
- Cache the response in SQLite (see #7) so the app can open offline and still show yesterday's queue.

**Explore first**:
- Make the call, dump the JSON to a file, diff against our mock shape.
- What does "size" look like on the API - already bytes? Missing for some items?

**Tests**:
- Adapter unit tests with a recorded JSON fixture (`fixtures/up_next.json`).
- Integration: login → fetch → assert non-empty + shape.
- UI: render states for empty Up Next, network failure, stale cache.

---

## 3. Episode download

**Why third**: nothing goes to the device without a local file to write.

**What**: given a Pocket Casts episode, download the media file (mp3 or mp4) to a local cache.

**Approach**:
- Pocket Casts gives each episode a direct media URL on the publisher's CDN (or a PC redirector). Fetch it in main process with `fetch` + `ReadableStream` → `fs.createWriteStream`.
- Cache path: `app.getPath('userData')/cache/<uuid>.<ext>`.
- Idempotent: if the file exists and size matches Content-Length (or stored checksum), skip.
- Progress reporting via IPC: `webContents.send('download:progress', {uuid, bytes, total})`. Throttle to ~10 Hz so we don't flood IPC.
- Support `Range` resume for interrupted downloads.
- Concurrency: download 2 episodes in parallel max (most podcast CDNs rate-limit).

**Explore first**:
- Pick one episode URL from the JSON, `curl -o` it, confirm we can play it in QuickTime.
- Check `Content-Length` and `Accept-Ranges: bytes` headers.

**Tests**:
- Unit: a fake HTTP server that 200s on GET, 206s on Range, drops connection mid-stream - verify resume.
- Integration: real download of a known small public mp3 (e.g. a PC test feed).
- UI: download progress renders in the Today screen; cancel mid-download frees the fd.

---

## 4. OpenSwim device detection

**Why fourth**: before sync is real, we need real answers to "is it plugged in?" The mount pill currently lies.

**What**: detect OpenSwim Pro mount/unmount events.

**Approach**:
- OpenSwim Pro mounts as USB Mass Storage on macOS - it appears as a volume under `/Volumes/`. Volume name: confirmed visually as `/Volumes/OPENSWIM` in the mock, but need to verify with the real device (could be `OPENSWIM`, `OPENSWIM PRO`, `ALIEL`, etc.).
- Option A: poll `fs.readdir('/Volumes')` every 2s. Simple, cross-platform-ish, no native deps.
- Option B: `fs.watch('/Volumes')` - fires on mount/unmount. Fewer wakeups.
- Option C: `node-usb-detection` - USB-level events. Overkill and adds a native module.
- Start with B, fall back to A.
- Heuristic for "is this *our* device": volume label matches `/^OPENSWIM/i`, OR directory contains a marker file we previously wrote (`.openswim-podcast`).
- Expose IPC event: `openswim.device.onChange(cb)` → `{mounted, path, label, capacityMB, freeMB}`.

**Explore first**:
- Plug the actual OpenSwim in, run `diskutil info /Volumes/<name>`, note volume label, filesystem (FAT32? exFAT?), capacity.
- Mount/unmount it a few times, observe `/Volumes` changes.

**Tests**:
- Unit: mock the watcher, feed mount/unmount events, verify state transitions.
- Integration (physical): plug/unplug the real device, check the pill changes.
- Edge case: device plugged in at app launch (detection should fire immediately, not wait for an event).

---

## 5. ffmpeg: video → audio conversion

**Why fifth**: before the sync pipeline runs end-to-end, video episodes need to become mp3.

**What**: convert VIDEO-kind downloads to 128 kbps mono mp3 at sync time.

**Approach**:
- Use `ffmpeg-static` (npm) - ships platform-specific binaries. Added to electron-builder `extraResources` so it's in the packaged app.
- Spawn as child_process: `ffmpeg -i in.mp4 -vn -acodec libmp3lame -b:a 128k -ac 1 out.mp3`.
- Progress by parsing stderr `time=HH:MM:SS.xx` and comparing to the source duration (probed ahead with `ffprobe -v error -show_entries format=duration`).
- Output goes next to the source in the cache dir: `<uuid>.mp3` (same name, different ext, so the downloader's idempotency check still makes sense).

**Explore first**:
- Manually convert one mp4 episode. Verify file plays on the OpenSwim (mono vs stereo matters for bone conduction).
- Check `ffmpeg-static` mac-arm64 binary works with Electron's `app.asar` unpacking.

**Tests**:
- Unit: given a known 10-second test clip, convert, verify output duration within 0.1s.
- Progress parser: feed it recorded stderr, assert percentage stream is monotonic.
- Integration: full download → convert → produce a playable mp3.

---

## 6. Sync pipeline: write to device

**Why sixth**: ties everything together. This replaces the setInterval fake in `SyncScreen.jsx`.

**What**: the real five-stage pipeline: finalise → delete → convert → transfer → verify.

**Approach**:
- Each stage is an async function with a progress stream. The UI subscribes to the whole pipeline and renders the stage bar it already has.
- Stages:
  1. **finalise**: snapshot the current `order` array, generate filenames `01_<show>.mp3` … `NN_<show>.mp3` with `fnameFor` logic already in TodayScreen.
  2. **delete**: `fs.readdir('/Volumes/OPENSWIM')`, filter our-owned mp3s (prefix `NN_`), `fs.unlink` each. Ignore files we don't own.
  3. **convert**: for each video in the queue not already converted, run ffmpeg.
  4. **transfer**: `fs.copyFile` cache path → device path. fsync. Progress via polling `fs.stat` on the destination every 100ms (streams-based progress is hard across `copyFile`; for better UX, pipe manually: `createReadStream.pipe(createWriteStream)` and count bytes).
  5. **verify**: sha256 of source vs destination. If mismatch, error.
- Transactional semantics: if a stage fails mid-queue, don't fail the whole sync - mark the episode errored, continue with the rest, surface in success screen.
- Safe-unplug: `mountState` goes to "busy" when any stage is writing. Existing MountDialog blocks eject.
- Plays nice with device eject: on completion, `diskutil eject /Volumes/OPENSWIM` (behind a button - don't auto-eject without user press).

**Explore first**:
- How slow is `fs.copyFile` to a real USB 2.0 device? Does it block the event loop? Try on a 50MB file.
- Does the OpenSwim enforce a filename length limit or FAT32-unsafe char rules?
- What happens if the device is unplugged mid-copy? We need a friendly error, not a crash.

**Tests**:
- Unit: filename generator, slot numbering, collision handling (two `HARD_FORK` episodes → `01_hardfork.mp3`, `02_hardfork.mp3`).
- Integration: point the pipeline at a RAM disk (`hdiutil attach -nomount ram://...`) and run end-to-end with 3 mock episodes.
- Error paths: device yanked during transfer, full device, read-only device.

---

## 7. Local catalogue (SQLite)

**Why seventh**: by now we have state to persist - downloads, device contents, user prefs.

**What**: move from `localStorage` and in-memory React state to a proper database.

**Approach**:
- `better-sqlite3` (synchronous, simple, fast, no native-module pain with Electron when built against the right headers via `electron-rebuild`).
- DB at `app.getPath('userData')/openswim.db`.
- Tables (first pass):
  - `episodes(uuid PK, show, title, duration, size, kind, media_url, fetched_at)` - cached PC metadata.
  - `downloads(uuid PK, path, bytes, sha256, downloaded_at)` - local cache index.
  - `syncs(id PK, started_at, ended_at, ok, notes)` - sync history.
  - `device_state(key PK, value)` - last known device label, last ejected at, etc.
  - `settings(key PK, value)` - user prefs.
- IPC layer: expose typed getters/setters, never raw SQL to the renderer.

**Explore first**:
- Confirm `better-sqlite3` builds for the Electron version we're on (might need `@electron/rebuild`).
- Or switch to `sql.js` if native modules become a pain (purely wasm, but slower and we lose fsync-style durability).

**Tests**:
- Migration tests (schema v1 → v2).
- Invariants: "every row in `downloads` has a file on disk at `path`" - fsck routine + test.

---

## 8. Settings, error UI, logs

**What**: user-facing parts we've been handwaving.

- Settings route: change PC account, choose cache location, clear cache, see version, open logs folder.
- Error toasts: network failure, bad credentials, device yanked, ffmpeg crash.
- Logs: structured logs (`pino` or similar) to `app.getPath('logs')/openswim.log`. "Reveal in Finder" button.

**Tests**: Playwright E2E: login fail → error banner → retry → success. Log file is written and non-empty after one sync.

---

## 9. Packaging, signing, updates

**What**: make it installable for real.

- electron-builder already scaffolded. Add an icon set (.icns).
- Apple Developer cert - codesign + notarise (or ship as an unsigned dmg with Gatekeeper override note; fine for "just me and Nikki use it" phase).
- Optional: `electron-updater` + GitHub Releases for auto-update.

**Tests**: install fresh `.dmg` on a clean macOS user, launch, go through full login→sync flow.

---

## 10. Stretch: playback-progress sync back to Pocket Casts

**What**: when OpenSwim finishes an episode, mark it played in Pocket Casts so it disappears from Up Next next sync.

- Tricky: OpenSwim has no internet, so we'd infer "played" by… the next time user syncs, we mark anything that was in the previous sync's queue as played. That's a lie (they might not have listened), but it matches the mental model.
- Probably a per-user setting: "auto-mark-played on next sync" on/off.

**Defer**: until everything else works.

---

## Proposed order of attack

1. **Pocket Casts login + Up Next fetch** (features 1 and 2 together - they prove the happy path). UI: replace LoginScreen cookie field with email+password, wire up.
2. **Download one episode, show it appearing in the Today queue as "downloaded"**. (feature 3, minimal.)
3. **Real device detection** (feature 4). Pill becomes truthful.
4. **ffmpeg conversion** (feature 5) - standalone test first, then integrate.
5. **Real sync pipeline** (feature 6) - now we can delete the fake setInterval.
6. **SQLite catalogue** (feature 7) - once we have real data worth persisting.
7. **Settings + logs** (feature 8).
8. **Packaging** (feature 9).
9. **Stretch** (feature 10) if still motivated.

At each step: merge small, test in the running Electron app, and keep the fake paths working behind a flag until the real path is solid, so we don't break the demo mid-build.
