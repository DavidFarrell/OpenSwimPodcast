const { ipcMain } = require("electron");
const pc = require("./pocketcasts.cjs");

function serializeError(e) {
  return { message: e.message || String(e), code: e.code, status: e.status };
}

function registerPocketCasts() {
  const handlers = {
    "pc:status": () => pc.status(),
    "pc:login": (_, { email, password }) => pc.login(email, password),
    "pc:logout": () => pc.logout(),
    "pc:upNext": () => pc.getUpNext(),
    "pc:podcastList": () => pc.getPodcastList(),
    "pc:history": () => pc.getHistory(),
    "pc:podcastFull": (_, uuid) => pc.getPodcastFull(uuid),
  };
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (ev, arg) => {
      try { return { ok: true, data: await fn(ev, arg) }; }
      catch (e) { return { ok: false, error: serializeError(e) }; }
    });
  }
}

module.exports = { registerPocketCasts };
