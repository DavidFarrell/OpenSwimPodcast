# Build overlay - Open Swimcast

**Repo:** `~/projects/OpenSwimPodcast` (workspace is `app/`)
**Stack:** Electron (main = CommonJS `.cjs` under `app/electron/`); renderer = React 18 + Vite (`.jsx`/`.js` under `app/src/`); Vitest for tests. All processing is local (fast-diarise transcription, LM Studio LLM at `:1234`, qwen-speak TTS).
**Style anchor:** the existing `app/src/transcriptToggle.js` + `TranscriptCutReview.jsx` + `app/electron/decisionCache.cjs` - small pure modules, heavy "why" comments only where the why is non-obvious, no framework ceremony. Do not go deeper/heavier than those files.
**Audience / reviewer:** David solo-builds this. GPT-5 (`/ask-gpt5`) is the adversarial reviewer and pre-commit gate. He dislikes over-abstraction, boiled-ocean tests, and anything that risks the cut path.

## Project-specific taste notes

- **CARDINAL RULE is sacred: zero false-positive cuts.** A sentence is cut ONLY when it is in the selected (yellow) set at Continue. No new work may change what gets cut. Any feature that touches the review/commit path must be provably incapable of altering the committed cut-set or blocking/breaking the transfer.
- **Detector is LOCKED:** `google/gemma-4-12b-qat`, quote-boundary method. Do not retune the detector. Adding fields to a cut object (cutId, retained quotes) is fine; changing boundaries / `needsReview` logic is not.
- The review surface is the binary click-to-toggle transcript (`TranscriptCutReview.jsx`): amber text = will cut, grey = kept, ⚑ gutter marker = detector-was-unsure (held). Cut-collapse logic in `transcriptToggle.js` is settled - reuse `sentenceLines`, `preselectFromCuts`, `heldLines`, `selectedToRanges`; do not reimplement them.
- Pure logic lives in plain `.js` modules (unit-tested without React/DOM); React and IPC are thin shells over them. Side effects (fs, IPC) pushed to the main-process edge.
- Build method: each slice on its own branch -> implement with tests -> `/ask-gpt5` review against the doctrine -> revise -> commit on READY-TO-SHIP + green tests -> PR. Tests green is non-negotiable before commit.

## Key reference files

- Review gate + commit: `app/src/SyncScreen.jsx` (the `review` state, `reviewSelected`, `continueReview()`, the gate render block ~line 520-566).
- Review surface: `app/src/TranscriptCutReview.jsx`; pure cut logic: `app/src/transcriptToggle.js`.
- Detector: `app/electron/detectAds.cjs` (cut descriptors); pipeline + cut assembly: `app/electron/sync.cjs`; decision sidecar pattern to mirror: `app/electron/decisionCache.cjs`; IPC: `app/electron/ipc.cjs` + `app/electron/preload.cjs`.
- Architecture history (read for context, do not duplicate): `docs/smart-processing/` (BUILD_PLAN.md, DESIGN_*.md).
- This feature's plan: `design/2026-06-18 - review-dataset-implementation-plan.md`.
