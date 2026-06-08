// Model-picker preferences (P4a).
//
// Selects which LM Studio model the announce summary and the trim detector use.
// Persisted in localStorage like the speed/boost/announce/trim toggles in
// App.jsx, under a single key:
//   - os_model : the chosen model id string (e.g. "google/gemma-4-12b-qat")
//
// The DEFAULT is the LOCKED detector model. The picker only lets the user point
// the announce summary and the detector at a different local model; it does NOT
// change the default and it does NOT change the locked detector method (windowing
// + quote-boundary mapping in detectAds.cjs). Both modules already accept a model
// param and fall back to their own LMSTUDIO_MODEL default, so an empty / unknown
// stored value degrades safely to that default rather than breaking detection.

const KEY = "os_model";

// The LOCKED default. Must match detectAds.cjs / announce.cjs LMSTUDIO_MODEL.
const DEFAULT_MODEL = "google/gemma-4-12b-qat";

// A small starter list for the pulldown. The default is first so it is the
// obvious choice. These are local LM Studio model ids; the list is advisory - any
// id the user has loaded will work, and an unknown stored id still degrades to the
// module default downstream.
const MODEL_OPTIONS = [
  "google/gemma-4-12b-qat",
  "google/gemma-2-27b-it",
  "qwen/qwen3-14b",
  "meta-llama/llama-3.1-8b-instruct",
];

// Load the chosen model id. Returns DEFAULT_MODEL when nothing is stored, the
// stored value is blank, or storage is unavailable - the picker never yields an
// empty model id.
function loadModel(storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return DEFAULT_MODEL;
  let v = null;
  try {
    v = s.getItem(KEY);
  } catch (_) {
    return DEFAULT_MODEL;
  }
  if (typeof v !== "string") return DEFAULT_MODEL;
  const trimmed = v.trim();
  return trimmed ? trimmed : DEFAULT_MODEL;
}

// Persist the chosen model id. A blank / non-string value resets to the default
// so we never store an empty model id that would later confuse the picker.
function saveModel(value, storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return;
  const v = (typeof value === "string" && value.trim()) ? value.trim() : DEFAULT_MODEL;
  try {
    s.setItem(KEY, v);
  } catch (_) {
    // storage full / unavailable - nothing to do, loadModel will fall back.
  }
}

export {
  loadModel,
  saveModel,
  KEY,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
};
