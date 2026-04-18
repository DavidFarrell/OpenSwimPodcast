import { useEffect, useState } from "react";

const api = () => (typeof window !== "undefined" && window.openswim && window.openswim.downloads) || null;

export function useDownloads() {
  const [byUuid, setByUuid] = useState({});

  useEffect(() => {
    const dl = api();
    if (!dl) return;
    let cancelled = false;
    dl.list().then((r) => {
      if (!cancelled && r.ok) {
        const m = {};
        for (const e of r.data) m[e.uuid] = e;
        setByUuid(m);
      }
    });
    const off = dl.onProgress((evt) => {
      setByUuid((prev) => ({ ...prev, [evt.uuid]: evt }));
    });
    return () => { cancelled = true; off && off(); };
  }, []);

  const ensure = (uuid, url, ext) => {
    const dl = api();
    if (!dl) return;
    dl.ensure(uuid, url, ext).then((r) => {
      if (r.ok) setByUuid((prev) => ({ ...prev, [uuid]: { ...(prev[uuid] || {}), ...r.data } }));
    });
  };

  return { byUuid, ensure };
}
