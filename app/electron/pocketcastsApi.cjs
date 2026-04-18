const zlib = require("node:zlib");

const API = "https://api.pocketcasts.com";
const CACHE = "https://cache.pocketcasts.com";

async function post(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`${res.status} ${res.statusText} ${txt.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getJsonMaybeGzip(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json", "Accept-Encoding": "identity" } });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} ${url}`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return JSON.parse(text);
}

async function login(email, password) {
  const res = await post(`${API}/user/login`, { email, password, scope: "webplayer" }, null);
  if (!res.token) throw new Error("no token in response");
  return res.token;
}

const getUpNext = (token) => post(`${API}/up_next/list`, { version: 2, model: "webplayer" }, token);
const getPodcastList = (token) => post(`${API}/user/podcast/list`, { v: 1 }, token);
const getHistory = (token) => post(`${API}/user/history`, {}, token);
const getPodcastFull = (uuid) => getJsonMaybeGzip(`${CACHE}/mobile/podcast/full/${uuid}`);

module.exports = { login, getUpNext, getPodcastList, getHistory, getPodcastFull, API, CACHE };
