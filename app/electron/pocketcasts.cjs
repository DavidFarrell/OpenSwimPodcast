const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const api = require("./pocketcastsApi.cjs");

function authPath() {
  return path.join(app.getPath("userData"), "auth.json");
}

function loadToken() {
  try {
    const raw = fs.readFileSync(authPath());
    const { enc, email } = JSON.parse(raw.toString());
    if (!enc || !safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(Buffer.from(enc, "base64"));
    return { token, email };
  } catch {
    return null;
  }
}

function saveToken(email, token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("safeStorage unavailable");
  const enc = safeStorage.encryptString(token).toString("base64");
  fs.mkdirSync(path.dirname(authPath()), { recursive: true });
  fs.writeFileSync(authPath(), JSON.stringify({ email, enc }));
}

function clearToken() {
  try { fs.unlinkSync(authPath()); } catch {}
}

let cached = null;
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  cached = loadToken();
  loaded = true;
}

async function withAuth(fn) {
  ensureLoaded();
  if (!cached) throw Object.assign(new Error("not authenticated"), { code: "NOT_AUTHED", status: 401 });
  try {
    return await fn(cached.token);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      clearToken();
      cached = null;
      throw Object.assign(new Error("session expired - please log in again"), { code: "AUTH_EXPIRED", status: e.status });
    }
    throw e;
  }
}

async function login(email, password) {
  const token = await api.login(email, password);
  saveToken(email, token);
  cached = { token, email };
  loaded = true;
  return { ok: true, email };
}

function logout() { ensureLoaded(); clearToken(); cached = null; return { ok: true }; }
function status() { ensureLoaded(); return { authed: !!cached, email: cached ? cached.email : null }; }

const getUpNext = () => withAuth((t) => api.getUpNext(t));
const getPodcastList = () => withAuth((t) => api.getPodcastList(t));
const getHistory = () => withAuth((t) => api.getHistory(t));
const getPodcastFull = (uuid) => api.getPodcastFull(uuid);

module.exports = {
  login, logout, status,
  getUpNext, getPodcastList, getHistory, getPodcastFull,
};
