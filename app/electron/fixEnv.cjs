// A GUI app launched from Finder/Spotlight inherits a stripped PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) - it does NOT see the user's shell PATH. That
// means bare-command spawns like `uv` (fast-diarise) or the qwen-speak venv tools
// are not found, and the smart-processing steps silently degrade to "skipped".
//
// This module repairs PATH at startup so the packaged app can find the local
// stack, exactly as it does when launched from a terminal. It is a no-op in dev
// (a terminal launch already has a good PATH) but is safe to call either way.
//
// Strategy: prepend the well-known macOS user bin dirs, then (best-effort) merge
// in the login shell's own PATH so machine-specific locations are picked up too.
// Everything is wrapped so a failure never blocks app start.

const { execSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

// The locations a Finder-launched app misses most often on macOS.
function knownDirs() {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".cargo", "bin"),
  ];
}

// Ask the user's login shell what PATH it sets up. Best-effort: returns [] on any
// problem (no shell, timeout, non-zero exit) so we still fall back to knownDirs().
function loginShellPath() {
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    // -i -l -c so rc/profile files run and export the real PATH. Marker delimits
    // the value from any banner noise a shell rc might print.
    const out = execSync(`${shellBin} -ilc 'printf "__OSW_PATH__%s__END__" "$PATH"'`, {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/__OSW_PATH__(.*?)__END__/s);
    if (m && m[1]) return m[1].split(":").filter(Boolean);
  } catch {
    // ignore - fall back to knownDirs only
  }
  return [];
}

// Build the repaired PATH: known dirs first, then login-shell dirs, then whatever
// PATH we already had, de-duplicated and order-preserving.
function repairedPath(currentPath) {
  const current = (currentPath || "").split(":").filter(Boolean);
  const merged = [...knownDirs(), ...loginShellPath(), ...current];
  const seen = new Set();
  const out = [];
  for (const dir of merged) {
    if (!seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(":");
}

// Install the repaired PATH onto process.env. Idempotent and never throws.
function fixEnv() {
  try {
    process.env.PATH = repairedPath(process.env.PATH);
  } catch {
    // never block startup over PATH repair
  }
  return process.env.PATH;
}

module.exports = { fixEnv, repairedPath, knownDirs, loginShellPath };
