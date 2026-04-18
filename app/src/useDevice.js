import { useEffect, useState } from "react";

const api = () => (typeof window !== "undefined" && window.openswim && window.openswim.device) || null;

export function useDevice() {
  const [device, setDevice] = useState({ available: false, mounted: false });

  useEffect(() => {
    const d = api();
    if (!d) { setDevice({ available: false, mounted: false }); return; }
    let cancelled = false;
    d.current().then((r) => {
      if (!cancelled && r.ok) setDevice({ available: true, ...r.data });
    });
    const off = d.onChange((s) => setDevice({ available: true, ...s }));
    return () => { cancelled = true; off && off(); };
  }, []);

  return device;
}

export function formatMB(mb) {
  if (mb == null) return null;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${Math.round(mb)}MB`;
}
