// Minimal append-only diagnostics log. The smart-processing steps degrade
// silently by design (a tool outage must never break a sync), but that made a
// real failure - e.g. a packaged app that cannot find `uv` - invisible. This logs
// WHY a step skipped so it can be diagnosed after the fact.
//
// It only writes when process.env.OSW_LOG points at a file (main.cjs sets this to
// the app's userData log path at startup). In unit tests OSW_LOG is unset, so this
// is a no-op and never touches disk. It never throws.

const fs = require("node:fs");

function logEvent(tag, detail) {
  try {
    const p = process.env.OSW_LOG;
    if (!p) return;
    const line = `${new Date().toISOString()} [${tag}] ${detail == null ? "" : String(detail)}\n`;
    fs.appendFileSync(p, line);
  } catch {
    // diagnostics must never affect the app
  }
}

module.exports = { logEvent };
