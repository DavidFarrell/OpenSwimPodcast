const STOPWORDS = new Set([
  "the", "a", "an", "and", "of", "on", "in", "by", "for", "with", "is", "to",
  "podcast", "show", "radio",
]);

const MIN_LEN = 8;
const MAX_LEN = 12;

export function slugShow(show) {
  if (!show) return "show";
  const words = String(show).toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  const pool = meaningful.length ? meaningful : words;
  if (!pool.length) return "show";

  let slug = pool[0];
  for (let i = 1; i < pool.length && slug.length < MIN_LEN; i++) {
    slug += pool[i];
  }
  return slug.slice(0, MAX_LEN);
}

export function fnameFor(show, slot, ext = "mp3") {
  return `${String(slot).padStart(2, "0")}_${slugShow(show)}.${ext}`;
}
