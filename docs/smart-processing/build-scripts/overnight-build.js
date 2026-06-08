export const meta = {
  name: 'openswim-overnight-build',
  description: 'Autonomously build Open Swimcast Phases 2-4 in GPT-5-gated slices (Trim, Review, Polish)',
  phases: [
    { title: 'Implement' },
    { title: 'Review' },
    { title: 'Revise' },
    { title: 'Commit' },
  ],
}

const REPO = '/Users/david/git/ai-sandbox/projects/OpenSwimPodcast'
const APP = REPO + '/app'
const BRANCH = 'smart-processing'
const ASKGPT5 = '/Users/david/.claude/skills/ask-gpt5/ask-gpt5.sh'
const DOCS = REPO + '/docs/smart-processing'

const HOUSE_RULES = `
HOUSE RULES (non-negotiable):
- Repo: ${REPO} (Electron app under ${APP}). On git branch "${BRANCH}". Never switch branch, never push, never merge.
- READ FIRST for full context: ${DOCS}/BUILD_PLAN.md (self-contained plan + conventions), ${DOCS}/SPEC.md (rationale), and for any detector work ${DOCS}/reference/quote_timewin.py (the LOCKED detector reference - port it faithfully).
- Style: NO em/en dashes; use " - ". Match surrounding code idiom.
- Dependency injection: any module that spawns a subprocess or makes an HTTP call MUST inject spawn/fetch (see app/electron/converter.cjs and announce.cjs) so unit tests never touch the real local stack. Mocked unit tests ARE the gate; real smoke tests are best-effort only.
- CARDINAL RULE for trim: ZERO false positives - never trim real audio content. When a boundary is ambiguous (a segment straddles ad-end/content-start), a quote fails to map, or a cut exceeds the needs-review threshold (~2.5 min, or mid-roll-ambiguous), DO NOT cut - leave audio intact and flag needs-review. Degrade safely; never throw into the pipeline; never abort the batch. Originals are never destroyed.
- Tests: npm test === "vitest run". After your change ALL tests (existing + new) must pass via "cd ${APP} && npx vitest run". Add regression tests that would FAIL on the bug being prevented. Do NOT loosen or delete existing tests.
- Do NOT git commit; committing is a separate gated step.
`

// Phase 2 (Trim), Phase 3 (Review), Phase 4 (buildable polish + spikes-as-notes).
const SLICES = [
  {
    id: 'P2a-converter-atrim',
    title: 'converter.cjs: cut time ranges (atrim) before atempo, composing with introPath',
    detail: `Extend app/electron/converter.cjs convert() to accept cuts: an array of [startSec,endSec] ranges on the ORIGINAL (pre-speed) episode timeline, removed from the episode audio BEFORE the atempo speed-up, composing with the existing introPath front-concat. Use the ffmpeg filtergraph (aselect/atrim+asetpts or the aselect 'between' approach) to drop the ranges, then apply atempo/boost to the remaining episode audio, then (if introPath) front-concat the normal-speed intro. Empty/absent cuts MUST produce byte-for-byte the same behaviour as today (no regression). Unit tests asserting the filtergraph is built correctly with cuts, without cuts, with cuts+intro+speed+boost together; plus a real-ffmpeg smoke test that generates a tone, cuts a middle slice, and asserts the output duration dropped by the cut length.`,
  },
  {
    id: 'P2b-detectAds',
    title: 'detectAds.cjs: port the locked quote-boundary detector',
    detail: `New module app/electron/detectAds.cjs. Port ${DOCS}/reference/quote_timewin.py FAITHFULLY into JS: build 30-min time windows with 3-min overlap (WIN=1800s, STRIDE=1620s) over the transcript segments; for each window call the LLM (model google/gemma-4-12b-qat at http://localhost:1234/v1/chat/completions, strict response_format json_schema {ads:[{first_line,last_line}]}) via an INJECTED fetch; read reasoning_content if content empty; map each returned first_line/last_line to segment indices by normalised substring match (lowercase, collapse whitespace, strip punctuation); on a quote-map failure SKIP that ad (fail safe). Return the set of ad segment-index ranges plus, per range, whether it is auto-applyable or needs-review (ambiguous boundary / over threshold). Degrade to empty (no cuts) on any LLM/parse failure. Unit tests with mocked fetch: a window with a clean ad maps to the right indices; a content-only window yields ZERO ads (zero-FP assertion); a quote that does not match any segment is skipped (not crashed); reasoning_content fallback path. Keep the prompt text identical in spirit to the reference VERIFY_INSTRUCTION.`,
  },
  {
    id: 'P2c-trim-pipeline',
    title: 'sync.cjs + ipc.cjs + preload.cjs: trim detection stage + cut list IPC',
    detail: `Wire trim into the pipeline. In app/electron/sync.cjs, for episodes with Trim enabled: reuse the Phase 1 transcript (transcribe.cjs), run detectAds, convert segment-index ranges to [startSec,endSec] cuts using segment start/end times, add positional intro/outro handling (treat a high-confidence leading/trailing interstitial block at the very edges as trimmable, which also sweeps the unframed pre-roll cross-promo gap), then pass auto-applyable cuts into converter.convert({cuts}). needs-review cuts are NOT auto-applied. Expose via ipc.cjs/preload.cjs (window.openswim, {ok,data} envelope): per-episode trim status (idle/analysing/ready/needs-review/skipped) and the proposed cut list (with seconds + labels + needsReview flag). Degrade safely: any failure skips trimming that episode and still converts. Tests with injected deps: trim-on happy path applies clean cuts and converts; a needs-review cut is held back; a detector/transcribe failure skips trim but still converts; trim-off path unchanged.`,
  },
  {
    id: 'P2d-trim-ui',
    title: 'TodayScreen.jsx: Trim universal toggle + per-episode disable + status badge',
    detail: `Mirror the Phase 1 Announce toggle. Add a universal "Trim" toggle to the staging toolbar (sets intent, no blocking modal), a per-episode override behind the row badge/overflow, and a passive status badge (analysing/ready/needs-review/skipped) driven by the P2c IPC. Persist toggle + per-episode overrides in localStorage following the existing app/src/announcePrefs.js pattern (create app/src/trimPrefs.js with the same shape + tests). Ensure "npx vitest run" stays green and "npm run build" compiles.`,
  },
  {
    id: 'P3a-cutlist-review',
    title: 'Review UI: coarse cut-list shown only for flagged cuts',
    detail: `Build a per-episode coarse cut-list review surface (component in app/src) that appears ONLY for episodes with needs-review cuts (from P2c). Each row shows the cut (e.g. "Mid-roll 23:10-24:05", with a confidence/reason), with keep and remove controls. This is NOT a waveform editor and NOT a full transcript editor. Wire to IPC to read flagged cuts and to record keep/remove decisions. Tests for render + decision recording. Keep build green.`,
  },
  {
    id: 'P3b-review-controls',
    title: 'Review UI: play-before/after/preview-join + -5s/+5s nudges + editable timestamp',
    detail: `Extend the P3a review rows with: play-before, play-after, preview-join (play a few seconds across the proposed join), coarse boundary nudges (-5s / +5s), and an editable timestamp field. These adjust a cut's boundaries before it is applied. Audio preview can use the existing converted/original file via the renderer's audio element. Tests for nudge math and boundary editing. Keep build green.`,
  },
  {
    id: 'P3c-decision-cache',
    title: 'Decision cache keyed by audio fingerprint',
    detail: `Persist reviewed trim decisions (keep/remove/adjusted boundaries) keyed by audio fingerprint (reuse the fingerprint scheme from transcribe.cjs) so re-processing the same episode reuses the user's reviewed choices and never re-asks. Sidecar cache like the transcript cache. Wire sync.cjs to consult it before flagging for review. Tests: a cached decision is reused (no re-flag); cache miss flags normally; corrupt cache tolerated. Keep green.`,
  },
  {
    id: 'P3d-advanced-evidence',
    title: 'Advanced transcript-as-evidence view',
    detail: `Add an Advanced (collapsed by default) view that shows the transcript segments with the detected ad ranges highlighted, as evidence only - not the primary review surface. Read-only. Tests for render. Keep build green.`,
  },
  {
    id: 'P4a-model-picker',
    title: 'Model-picker pulldown (gemma-4-12b-qat default)',
    detail: `Add a model picker to the settings/staging UI that selects which LM Studio model the announce summary and the trim detector use. Default google/gemma-4-12b-qat. Persist in localStorage. Thread the chosen model id into announce.cjs and detectAds.cjs (they already accept a model param/default). Do NOT change the default or the locked detector method. Tests for persistence + threading. Keep green.`,
  },
  {
    id: 'P4b-sensitivity',
    title: 'Conservative/aggressive sensitivity setting (threshold tuning only)',
    detail: `Add a user setting that tunes the needs-review threshold (e.g. conservative = lower auto-apply duration cap / more flagging; aggressive = higher). This ONLY changes what is flagged-vs-auto-applied; it must NEVER weaken the zero-false-positive cardinal rule or the quote-map fail-safe. Persist in localStorage; thread into the P2c logic. Tests that conservative flags more and aggressive flags less, and that both still never auto-apply a quote-map-failed or ambiguous cut. Keep green.`,
  },
  {
    id: 'P4c-spikes-note',
    title: 'Design notes for the two spikes (no forced implementation)',
    detail: `Do NOT force an implementation. Investigate and write a concise design note at ${DOCS}/PHASE4_SPIKES.md covering: (1) per-podcast intro fingerprinting - how to detect the byte-identical repeated intro across a feed's episodes (e.g. audio fingerprint / chromaprint, or transcript-prefix similarity) and trim it with no LLM; sketch the data flow and where it would hook in. (2) word-level boundary precision - investigate whether fast-diarize/Parakeet (see ${DOCS}/reference and the fast_mac_transcribe project) can emit word-level timestamps, and what it would take; report findings. Commit only the markdown note (plus any tiny investigation script). This slice's "tests" requirement is waived - just ensure the existing suite still passes and the note is committed.`,
  },
]

function implementPrompt(slice, i, committed) {
  return `Implement ONE slice of the Open Swimcast smart-processing build. Implement ONLY this slice.

SLICE ${slice.id}: ${slice.title}

WHAT TO DO:
${slice.detail}
${HOUSE_RULES}

${committed.length ? `Already committed this run: ${committed.map(c => c.slice + ' @ ' + c.sha).join('; ')}` : 'First slice of this run; Phase 1 is already committed.'}

STEPS:
1. Read ${DOCS}/BUILD_PLAN.md and the relevant existing files first.
2. Implement the change plus tests (unless this slice waives tests).
3. From ${APP} run "npx vitest run"; all green (and "npm run build" if the slice touches src/). Fix until green.
4. Stage with "cd ${REPO} && git add -A"; do NOT commit.
Return structured data (your message is consumed as data).

Return: filesChanged, testsPassing, testSummary, summary, deviations.`
}
const IMPL_SCHEMA = { type: 'object', additionalProperties: false, required: ['filesChanged', 'testsPassing', 'testSummary', 'summary', 'deviations'], properties: { filesChanged: { type: 'array', items: { type: 'string' } }, testsPassing: { type: 'boolean' }, testSummary: { type: 'string' }, summary: { type: 'string' }, deviations: { type: 'string' } } }

function reviewPrompt(slice) {
  return `You are the INDEPENDENT GPT-5 review gate for one slice of the Open Swimcast smart-processing build. Obtain GPT-5's review and return its verdict as structured data. You do not write the code.

SLICE ${slice.id}: ${slice.title}
SLICE SPEC:
${slice.detail}

STEPS:
1. Diff: cd ${REPO} && git add -A && git diff --cached
2. Write a review request to /tmp/osw-rev-${slice.id}.txt with: (a) what the slice must do (spec above), (b) the hard requirements - the trim CARDINAL RULE (zero false positives, never trim real content; ambiguous/quote-map-failed/over-threshold cuts must NOT auto-apply); graceful degradation (no throw, no batch abort); originals never destroyed; no em/en dashes; tests genuinely cover the behaviour and pass, (c) the full diff, (d) instruct GPT-5 to reply with "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES" then only blocking issues (no nitpicks; this is a swim app).
3. Run: ${ASKGPT5} -p /tmp/osw-rev-${slice.id}.txt -e high -o /tmp/osw-rev-${slice.id}.out (wait; minutes).
4. Read the .out file, translate faithfully, and independently run "cd ${APP} && npx vitest run" for testsPassing.

Return: verdict ("approve"|"request_changes"), testsPassing, summary, blockingIssues (array; empty if approve), gpt5Raw (first ~600 chars).`
}
const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'testsPassing', 'summary', 'blockingIssues', 'gpt5Raw'], properties: { verdict: { type: 'string', enum: ['approve', 'request_changes'] }, testsPassing: { type: 'boolean' }, summary: { type: 'string' }, blockingIssues: { type: 'array', items: { type: 'string' } }, gpt5Raw: { type: 'string' } } }

function revisePrompt(slice, review) {
  return `GPT-5 requested changes on slice ${slice.id} ("${slice.title}"). Fix EVERY blocking issue, keep all tests green, re-stage, do NOT commit.
SLICE SPEC:
${slice.detail}
${HOUSE_RULES}
BLOCKING ISSUES:
${review.blockingIssues.map((b, n) => `${n + 1}. ${b}`).join('\n')}
GPT-5 overall: ${review.summary}
STEPS: fix each; from ${APP} run "npx vitest run" until green; "cd ${REPO} && git add -A" (no commit).
Return: filesChanged, testsPassing, testSummary, summary, deviations.`
}

function commitPrompt(slice) {
  return `Commit approved slice ${slice.id} ("${slice.title}").
1. From ${APP} run "npx vitest run". If ANY fail, do NOT commit - report committed=false, testsPassing=false.
2. If green: cd ${REPO} && git commit -m "$(printf '%s' 'Open Swimcast ${slice.id}: <one-line summary>\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
3. sha: git rev-parse --short HEAD. Do NOT push/merge. Stay on ${BRANCH}.
Return: committed, sha, testsPassing, message.`
}
const COMMIT_SCHEMA = { type: 'object', additionalProperties: false, required: ['committed', 'sha', 'testsPassing', 'message'], properties: { committed: { type: 'boolean' }, sha: { type: 'string' }, testsPassing: { type: 'boolean' }, message: { type: 'string' } } }

const results = []
const committed = []

for (let i = 0; i < SLICES.length; i++) {
  const slice = SLICES[i]
  log(`Slice ${i + 1}/${SLICES.length}: ${slice.id} - implementing`)
  const impl = await agent(implementPrompt(slice, i, committed), { label: `impl:${slice.id}`, phase: 'Implement', schema: IMPL_SCHEMA })
  if (!impl) { results.push({ slice: slice.id, status: 'ERROR', note: 'implement agent died' }); break }

  let review = null, approved = false
  for (let round = 0; round <= 2; round++) {
    review = await agent(reviewPrompt(slice), { label: `review:${slice.id}:r${round}`, phase: 'Review', schema: REVIEW_SCHEMA })
    if (!review) break
    log(`Slice ${slice.id} review r${round}: ${review.verdict} (tests ${review.testsPassing ? 'green' : 'RED'})`)
    if (review.verdict === 'approve' && review.testsPassing) { approved = true; break }
    if (round === 2) break
    const rev = await agent(revisePrompt(slice, review), { label: `revise:${slice.id}:r${round}`, phase: 'Revise', schema: IMPL_SCHEMA })
    if (!rev) break
  }

  if (!approved) {
    results.push({ slice: slice.id, status: 'BLOCKED', review: review ? review.summary : 'no review', issues: review ? review.blockingIssues : [] })
    log(`Slice ${slice.id} BLOCKED - stopping the chain.`)
    break
  }

  const commit = await agent(commitPrompt(slice), { label: `commit:${slice.id}`, phase: 'Commit', schema: COMMIT_SCHEMA })
  if (!commit || !commit.committed) {
    results.push({ slice: slice.id, status: 'COMMIT_FAILED', review: review.summary, note: commit ? commit.message : 'commit agent died' })
    break
  }
  committed.push({ slice: slice.id, sha: commit.sha })
  results.push({ slice: slice.id, status: 'committed', sha: commit.sha, message: commit.message, review: review.summary })
  log(`Slice ${slice.id} committed @ ${commit.sha}`)
}

return { branch: BRANCH, committed, results }
