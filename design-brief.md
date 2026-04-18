# OpenSwim Podcast — Design Brief

A behavioural spec for the visual designer. Describes **what the app does and how the user moves through it**, not how it's built. Engineering details are out of scope.

Pair this with `design-system/` (tokens, components, example screens in `design-system/index.html`) and the four reference screenshots in `inspo/reference-0[1-4]-*.jpg`.

---

## 1. What the app is for

David listens to podcasts in Pocket Casts. Before he goes swimming he wants to sideload a few episodes to the MP3 drive inside his waterproof swim headphones (**OpenSwim Pro**). This app is the thing he opens every morning to curate and sync today's swim queue.

Core user journey:

1. **Up Next** — pick which episodes to put on the headset, in what order
2. **Today** — review exactly what will change on the headset (additions, removals, renames, conversions)
3. **Sync** — watch the staged process run, eject safely
4. **Success** — confirmation + safe-to-unplug

---

## 2. Vocabulary

- **Pocket Casts** — source of truth for the podcast library and the user's **Up Next** queue
- **Up Next** — the ordered list of episodes the user has queued in Pocket Casts on their phone
- **OpenSwim Pro** — the waterproof headphones, which mount as a USB disk when plugged in
- **Headset** — same thing, used interchangeably
- **Pill** — a small badge shown on a row indicating "this episode will be at position N on the headset after sync"
- **Today** — the current state of the headset: what's on it right now
- **Sync** — the staged process that reconciles Today to the user's new selection

---

## 3. Core model: one pill to rule them all

The pill is the single visual primitive that drives the whole app. It represents **a slot in the headset's playlist**.

- Every episode on the headset has a pill showing its play position
- When the user taps an un-pilled row in **Up Next**, the row gets the next available pill number (appended to the end)
- When the user taps a pilled row, its pill is removed and higher pills **bubble up** (tap off pill 3 → old-pill-4 becomes 3, old-pill-5 becomes 4, etc.)
- On app load, already-on-headset items already have their pills showing their current headset positions. If nothing has changed in Pocket Casts or on the headset, the pills look identical to the last time the user opened the app.

**Consequence:** "selection" and "already on headset" are the same state, drawn the same way. The user never thinks about two separate concepts.

**Reorder:** there is no drag handle. Up Next's row order is always Pocket Casts' order — the app never mutates it. To reorder, the user untaps and retaps. Because they're only ever queuing ~10 items at a time, this is cheap.

**Filter-then-tap is a power move:** user types "tell em steve" into the filter, sees only Tell 'Em Steve-Dave episodes, taps a few, clears the filter, pills persist across the filter change.

---

## 4. Screens

### 4.1 Onboarding / Connect

Shown **only when no Pocket Casts session cookie is stored in the keychain**. Otherwise skipped — the app boots straight to Up Next.

Reference: `Untitled.jpg`.

Content:
- App mark (OS logo)
- Headline: "Morning swim. Seven episodes." (or playful variant)
- Eyebrow: "CONNECT POCKET CASTS"
- Text input: session cookie paste
- Cancel / Connect buttons
- Reassurance line: "stored in keychain · not shown again"

Designer can explore alternatives. Not much state here.

### 4.2 Up Next (primary screen)

Reference: `Untitled 2.jpg`.

**Header area:**
- Eyebrow: `UP NEXT · 120 EPISODES`
- Title: "Pick what you want on the headset today."
- Top-right actions: **Clear** (remove all pills), **Review today →** (advance to Today)

**Filter bar (above list):**
- Search input with `⌘K` shortcut hint
- Segmented toggle: `ALL / AUDIO / VIDEO`
- Right-aligned counter: `120 shown` (updates live with filter)

**Row anatomy (each episode):**
- Leading position number (01, 02, …) — this is the row's position in **Pocket Casts' Up Next order**, never changes based on selection
- Tiny artwork swatch
- Episode title · inline `VIDEO` tag if applicable
- Feed name (small caps, below title)
- Duration (JetBrains Mono, right-aligned)
- File size in MB (JetBrains Mono, right-aligned)
- **Pill zone** (trailing) — shows the headset-position pill if this row is pilled; empty otherwise

**Row states to design:**
- Neutral / unpilled
- Pilled (shows headset-position number, distinct styling from the leading PC-order number)
- Filtered out (hidden from view, not greyed — filter is a narrowing, not a dimming)
- Video (shows `VIDEO` tag; designer decides if this warrants additional treatment, e.g. a conversion-cost hint)

**Empty states to design:**
- Pocket Casts Up Next is empty ("Your Pocket Casts queue is empty. Add something and come back.")
- All items filtered out ("No episodes match 'xyz'.")

### 4.3 Today (review)

Reference empty state: `Untitled 3.jpg`.

Today is **the current state of the headset, updated live by selections on Up Next**. When the user clicks "Review today →", they arrive here with a clear picture of what will change after sync.

**Header area:**
- Eyebrow: `TODAY · 7 EPISODES` (or whatever)
- Title: plain language summary, e.g. "Swapping 3 episodes. Keeping 4. Adding 3 new."
- Top-right actions: `← back` to Up Next, `Start sync →`

**Row fates the designer MUST distinguish visually:**
1. **Staying — same position.** No change. Calm, unstyled row.
2. **Staying — new position.** Will be renamed to reflect new pill number. Row shows old position → new position indicator.
3. **Being removed.** User untapped this. Row has strike / removal treatment.
4. **New — plain MP3.** Coming in fresh, no conversion needed.
5. **New — needs conversion.** Came from a video or non-MP3 source. Row shows conversion badge / cost hint.

Mystery files on the headset (not in the app's knowledge of what it last wrote) are silently deleted without special UI — the app is the sole writer, so unknown files are discardable.

**Empty state** (`Untitled 3.jpg`): "Your headset is empty. → PULL FROM UP NEXT" amber CTA.

### 4.4 Sync (staged process)

Reference (single-bar version): `Untitled 4.jpg`. **The designer should expand this into a multi-stage stepper or flowchart.** The real behaviour has several stages; the user needs to see which one is running right now in case they need to eject.

**Stages, in order:**

1. **Finalise list** — quick, usually instant
2. **Delete** — remove files no longer needed (and any mystery files)
3. **Rename** — update filenames on files that are staying but changing position
4. **Convert** — non-MP3 sources get converted to MP3. Per-file progress, running ETA.
5. **Transfer** — write new files to the headset. Per-file progress, running ETA.
6. **Verify** — checksum / fsync to make sure writes really landed (guards against OS lying about USB completion)
7. **Safe to eject** — terminal success state

The designer decides the layout (vertical stepper, horizontal flow, card stack, etc.) but each stage needs:
- A name
- A status (pending / running / done / failed)
- Sub-progress when relevant (Converting 2 of 4, 43%; Transferring 3 of 7, 61%, 1.8 MB/s, ETA 38s)
- A way to surface per-stage errors without halting the whole pipeline (one file failed to convert → log it, keep going)

**Top-right cancel** stays available throughout. See §5.2 for eject mid-sync.

### 4.5 Success

Dedicated state after a successful sync. Designer's call whether this is:
- A fourth rail item (`Done` / `Ready`) that lights up on completion, or
- The Sync screen transforming into a "Safe to unplug" state with stats, or
- A modal / celebratory overlay

Content should include:
- Episode count, total size, total duration
- Time the sync took
- "Safe to unplug" affordance (and/or auto-trigger the eject)
- Primary action to return to Up Next for the next sync

---

## 5. Cross-screen components

### 5.1 Left rail

Reference: visible in all loaded-state screenshots.

Persistent vertical rail with:
- Brand lockup (top): `OpenSwim · Podcast`
- Nav items, in flow order:
  - **Up Next** — `POCKET CASTS`
  - **Today** — `QUEUE`
  - **Sync** — `DEVICE`
  - (optionally a 4th success item — designer's call, see §4.5)
- **Mount status pill** (bottom) — see §5.2

The rail reflects state but doesn't gate it. User can click between screens freely (but see §5.3).

### 5.2 Mount status pill

Bottom-left. Always present.

**States:**
- `OPENSWIM PRO · NOT CONNECTED` — dim, no dot
- `OPENSWIM PRO · MOUNTED · 1.2 GB / 3.8 GB USED` — amber dot, live capacity
- `OPENSWIM PRO · BUSY` — pulsing during active sync stage
- `OPENSWIM PRO · SAFE TO UNPLUG` — transient state after successful eject

**Interaction:**
- **Click while idle** → attempts eject. If successful, pill transitions to "SAFE TO UNPLUG" (or disappears / dims depending on designer taste).
- **Click while sync is running** → popup with wind-down options:
  - "Finish current file then eject" (graceful — finishes the file in flight then stops)
  - "Force eject now" (warning: current file may be corrupt)
  - "Cancel, keep syncing" (dismiss the popup)
  - Popup shows progress summary: "You've transferred 2 of 10 files. Some new episodes won't be available on the headset today."

Capacity readout:
- Visible at all times when mounted
- Designer decides format: `1.2 GB / 3.8 GB USED`, or a tiny bar, or similar
- Up Next and Today can reference the same pill (no duplicate capacity UI needed)
- Warning state if today's selection exceeds free space — Today screen should surface this prominently in its header area, and the Start Sync button should reflect the conflict

### 5.3 No hard navigation gates

The user can move between Up Next, Today, and Sync freely. Two soft constraints:

- Clicking "Start sync" commits to the current selection — if the user goes back to Up Next mid-sync and changes pills, that's fine, but those changes won't affect the currently-running sync. (Designer may want a subtle "syncing" indicator on other screens.)
- Closing the app mid-sync must not leave the disk in a corrupt state. The one hard guarantee: **never mangle the headset's filesystem**. Designer doesn't need to surface this — it's an engineering concern.

---

## 6. What's left for the designer to explore

Intentional gaps. Don't feel bound by the reference screenshots.

- **Row visual for the 5 Today row-fates** — biggest creative territory. Use colour / motion / iconography / strike-through / before-after arrows as taste dictates.
- **Sync stage layout** — vertical stepper, flowchart with arrows, card stack, horizontal timeline. The must-haves are listed in §4.4; the visual is yours.
- **Success screen format** — rail item, inline transformation of Sync, celebratory overlay, stats card. Pick what feels right.
- **Video badge treatment** — the reference shows an inline `VIDEO` tag. Could also warrant a format conversion hint ("→ MP3") or be redundant given the Today screen already flags conversions.
- **Filter UX** — is the filter input always visible or summoned by `⌘K`? Does it get chips for active scope (e.g. after typing "lex", show a dismissable "lex" chip)?
- **Motion** — how rows react to tap (pill appears, others renumber), how Today reconciles a change, how Sync transitions between stages. Good opportunity for personality.
- **Mid-sync display on non-Sync screens** — do Up Next and Today show a subtle "syncing" badge, or is it only on the rail / mount pill?
- **Onboarding moment after first sync** — optional tooltip / empty-state copy that explains the pill model the first time.
- **Error states** — device disconnected mid-sync, Pocket Casts session expired, conversion failure, verify failure. Designer should cover at least the first two; the rest can come later.

---

## 7. What's NOT up for redesign

A small list of things that ARE decided. Don't spend cycles reconsidering them.

- **Pill as the single position primitive** (§3)
- **Up Next always respects Pocket Casts' source order** — no manual reordering of rows themselves
- **Amber = "happening right now"** — mount dot, active progress, the one primary CTA on each screen. Nothing else is amber.
- **Space Grotesk everywhere except metadata; JetBrains Mono for metadata** (durations, sizes, counts, logs) — baked into the design system
- **Flat, not rounded** — `--radius: 0` is intentional
- **Show names ALL CAPS, episode titles Sentence case** — part of the visual hierarchy

---

## 8. Reference

- `design-system/` — tokens, components, rules, example HTML
- `design-system/index.html` — rendered workbench
- `design-system/DECISIONS.md` — type / colour / motion decisions already made
- `inspo/reference-0[1-4]-*.jpg` — rough reference screenshots from David's exploration
- `inspo/` — first inspiration image
