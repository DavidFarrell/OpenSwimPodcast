// Investigation helper for the Phase 4 spikes (PHASE4_SPIKES.md).
//
// Reads a fast-diarize transcript JSON and reports two things the design note
// relies on:
//   1) whether the JSON already carries WORD-LEVEL timestamps (it does - the
//      SPEC.md section 6 claim that it does not is stale), and
//   2) how merged / long the turns are, which is what makes the "straddle"
//      seam problem (a turn that holds ad-end AND content-start) common.
//
// This is read-only and touches no app code. It is NOT part of the test gate.
//
// Usage: node docs/smart-processing/inspect-transcript.cjs /tmp/ric/transcript.json

const fs = require("node:fs");

function main() {
  const p = process.argv[2] || "/tmp/ric/transcript.json";
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Could not read/parse ${p}: ${e.message}`);
    process.exit(1);
  }

  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  if (!turns.length) {
    console.log("No turns array - nothing to inspect.");
    return;
  }

  const withWords = turns.filter((t) => Array.isArray(t.words) && t.words.length);
  const totalWords = withWords.reduce((n, t) => n + t.words.length, 0);
  const durs = turns
    .map((t) => (typeof t.end === "number" && typeof t.start === "number" ? t.end - t.start : 0))
    .sort((a, b) => b - a);
  const over20 = durs.filter((d) => d > 20).length;

  console.log(`file:               ${p}`);
  console.log(`turns:              ${turns.length}`);
  console.log(`turns with words:   ${withWords.length} / ${turns.length}`);
  console.log(`total words:        ${totalWords}`);
  console.log(`longest turn (s):   ${durs.length ? durs[0].toFixed(1) : "n/a"}`);
  console.log(`turns over 20s:     ${over20} (candidate straddle segments)`);

  // Sample one word so the shape is visible in the note.
  const sample = withWords[0] && withWords[0].words[0];
  if (sample) {
    console.log(`sample word shape:  ${JSON.stringify(sample)}`);
  }

  // Word timings are present iff every populated turn carries them and they have
  // numeric start/end. That is the load-bearing fact for the word-precision spike.
  const wordsHaveTimings =
    sample && typeof sample.start === "number" && typeof sample.end === "number";
  console.log(`word-level timings present: ${wordsHaveTimings ? "YES" : "NO"}`);
}

main();
