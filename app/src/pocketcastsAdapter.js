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
    return {
      ...it,
      dur: durSec ? fmtDuration(durSec) : it.dur,
      durMin: durSec ? Math.round(durSec / 60) : it.durMin,
      size: bytes ? fmtSize(bytes) : it.size,
      sizeMB: bytes ? bytes / (1024 * 1024) : it.sizeMB,
      kind: kindFrom(ex.file_type) || it.kind,
      show: it.show === "PODCAST" && podcastFull.podcast.title ? podcastFull.podcast.title.toUpperCase() : it.show,
    };
  });
}
