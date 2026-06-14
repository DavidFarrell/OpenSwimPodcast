function fmtDuration(sec) {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
           : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${mb.toFixed(0)}M` : `${mb.toFixed(1)}M`;
}

function kindFrom(fileType) {
  if (!fileType) return "AUDIO";
  return fileType.toLowerCase().startsWith("video") ? "VIDEO" : "AUDIO";
}

// Normalise a feed episode/season number to a positive integer, or null. Pocket
// Casts sends a number, a numeric string, or 0/null for "no number"; only a real
// positive whole number is a usable episode/season number for the spoken intro.
function normNumber(value) {
  if (value == null) return null;
  const n = typeof value === "number" ? value : parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return null;
  return n;
}

export function adaptUpNext({ upNext, podcasts = [], history = [] }) {
  const podcastTitle = new Map();
  for (const p of podcasts) podcastTitle.set(p.uuid, (p.title || "").toUpperCase());

  const historyByUuid = new Map();
  for (const h of history) historyByUuid.set(h.uuid, h);

  return upNext.map((ep, i) => {
    const h = historyByUuid.get(ep.uuid);
    const durSec = h && h.duration ? h.duration : 0;
    const bytes = h && h.size ? Number(h.size) : 0;
    const fileType = h && h.fileType ? h.fileType : (ep.url && /\.(mp4|m4v|mov)(\?|$)/i.test(ep.url) ? "video/mp4" : "audio/mpeg");

    return {
      id: i + 1,
      uuid: ep.uuid,
      podcastUuid: ep.podcast || (h && h.podcastUuid),
      title: ep.title,
      show: podcastTitle.get(ep.podcast) || (h && h.podcastTitle?.toUpperCase()) || "PODCAST",
      url: ep.url,
      published: ep.published,
      // Episode/season number are not on the up-next payload; podcast/full
      // supplies them (enrichFromPodcastFull). Default null so the field always
      // exists and a numbered show is filled in once enriched.
      episodeNumber: null,
      seasonNumber: null,
      dur: fmtDuration(durSec),
      durMin: Math.round(durSec / 60),
      size: fmtSize(bytes),
      sizeMB: bytes ? bytes / (1024 * 1024) : 0,
      kind: kindFrom(fileType),
    };
  });
}

export function enrichFromPodcastFull(items, podcastFull) {
  const byUuid = new Map();
  for (const ep of podcastFull.podcast.episodes) byUuid.set(ep.uuid, ep);
  return items.map((it) => {
    const ex = byUuid.get(it.uuid);
    if (!ex) return it;
    const durSec = ex.duration || 0;
    const bytes = ex.file_size || 0;
    // Episode/season number for the deterministic spoken intro (announce.cjs).
    // podcast/full is the source - numbered shows expose ex.episode / ex.season;
    // narrative shows omit them, leaving these null. A null keeps the existing
    // value so we never clobber a number captured elsewhere.
    const episodeNumber = normNumber(ex.episode);
    const seasonNumber = normNumber(ex.season);
    return {
      ...it,
      dur: durSec ? fmtDuration(durSec) : it.dur,
      durMin: durSec ? Math.round(durSec / 60) : it.durMin,
      size: bytes ? fmtSize(bytes) : it.size,
      sizeMB: bytes ? bytes / (1024 * 1024) : it.sizeMB,
      kind: kindFrom(ex.file_type) || it.kind,
      episodeNumber: episodeNumber != null ? episodeNumber : it.episodeNumber,
      seasonNumber: seasonNumber != null ? seasonNumber : it.seasonNumber,
      show: it.show === "PODCAST" && podcastFull.podcast.title ? podcastFull.podcast.title.toUpperCase() : it.show,
    };
  });
}
