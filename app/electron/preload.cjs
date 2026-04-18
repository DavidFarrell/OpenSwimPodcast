const { contextBridge, ipcRenderer } = require("electron");

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld("openswim", {
  platform: process.platform,
  version: process.versions.electron,
  pocketcasts: {
    status: () => invoke("pc:status"),
    login: (email, password) => invoke("pc:login", { email, password }),
    logout: () => invoke("pc:logout"),
    upNext: () => invoke("pc:upNext"),
    podcastList: () => invoke("pc:podcastList"),
    history: () => invoke("pc:history"),
    podcastFull: (uuid) => invoke("pc:podcastFull", uuid),
  },
  downloads: {
    ensure: (uuid, url, ext) => invoke("downloads:ensure", { uuid, url, ext }),
    cancel: (uuid) => invoke("downloads:cancel", uuid),
    list: () => invoke("downloads:list"),
    onProgress: (cb) => {
      const listener = (_e, evt) => cb(evt);
      ipcRenderer.on("downloads:progress", listener);
      return () => ipcRenderer.removeListener("downloads:progress", listener);
    },
  },
});
