const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("openswim", {
  platform: process.platform,
  version: process.versions.electron,
});
