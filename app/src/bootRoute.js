// Boot route policy (Fix 2).
//
// A cold boot must ALWAYS land on the queue ("up-next"), never on a saved route.
// Previously App.jsx restored os_route from localStorage verbatim, so a boot
// could land on the transient "syncing"/Transfer screen, which paints empty/low
// then settles once data loads. We still persist the current route within a
// session (so the value is there for diagnostics / future use), but the boot
// route is fixed: loadBootRoute IGNORES any stored value and returns "up-next".
//
// Mirrors the small pure prefs modules (modelPrefs.js etc.): a couple of pure
// functions over an injectable storage, safe when storage is missing.

const ROUTE_KEY = "os_route";

// The route every cold boot starts on. Not configurable - the queue is the home
// screen and the only safe place to start before the feed has loaded.
const BOOT_ROUTE = "up-next";

// The boot route. ALWAYS "up-next" - a stored os_route is deliberately NOT
// restored on boot, so a transient screen can never be the landing screen. The
// storage argument is accepted for symmetry with saveRoute (and so a test can
// prove a stored value is ignored) but is never read.
function loadBootRoute(_storage) {
  return BOOT_ROUTE;
}

// Persist the current within-session route. Best-effort: a missing / throwing
// storage is a no-op (the boot route does not depend on this value anyway).
function saveRoute(route, storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s || typeof route !== "string" || !route) return;
  try {
    s.setItem(ROUTE_KEY, route);
  } catch (_) {
    // storage full / unavailable - nothing to do.
  }
}

export {
  loadBootRoute,
  saveRoute,
  ROUTE_KEY,
  BOOT_ROUTE,
};
