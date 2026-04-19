const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { convert: defaultConvert } = require("./converter.cjs");

class AbortError extends Error {
  constructor() { super("aborted"); this.name = "AbortError"; }
}

function isOurFilename(name) {
  return /^\d{2}_[a-z]+\.mp3$/.test(name);
}

async function sha256File(p) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(p);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function defaultCopy(src, dest, { onProgress, signal } = {}) {
  const totalBytes = (await fsp.stat(src)).size;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const read = fs.createReadStream(src);
    const write = fs.createWriteStream(dest);
    let copied = 0;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      read.destroy();
      write.destroy();
      reject(new AbortError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    read.on("data", (chunk) => {
      copied += chunk.length;
      if (onProgress) {
        try { onProgress({ bytes: copied, total: totalBytes }); } catch {}
      }
    });
    read.on("error", (e) => { if (!aborted) reject(e); });
    write.on("error", (e) => { if (!aborted) reject(e); });
    write.on("finish", () => { if (!aborted) resolve(); });
    read.pipe(write);
  });
  return { bytes: totalBytes };
}

function buildPlan({ queue, existingDeviceFiles = [] }) {
  const plan = [];
  plan.push({ stage: "finalise", kind: "info", text: `order locked · ${queue.length} slots` });

  const newNames = new Set(queue.map((q) => q.filename));
  for (const name of existingDeviceFiles) {
    if (isOurFilename(name) && !newNames.has(name)) {
      plan.push({ stage: "delete", kind: "del", text: `rm ${name}`, filename: name });
    }
  }

  for (const it of queue) {
    if (it.ext && it.ext !== "mp3") {
      plan.push({ stage: "convert", kind: "conv", text: it.title, uuid: it.uuid, slot: it.slot });
    }
  }

  for (const it of queue) {
    plan.push({ stage: "transfer", kind: "xfer", text: it.filename, uuid: it.uuid, slot: it.slot, filename: it.filename });
  }

  plan.push({ stage: "verify", kind: "info", text: `checksum ${queue.length} files` });
  return plan;
}

async function runSync({
  devicePath, cacheDir, queue,
  speed = 1.0,
  convertFn = defaultConvert,
  copyFn = defaultCopy,
  onEvent,
  signal,
} = {}) {
  if (!devicePath) throw new Error("devicePath is required");
  if (!cacheDir) throw new Error("cacheDir is required");
  if (!Array.isArray(queue)) throw new Error("queue is required");
  const needsEncode = speed && speed !== 1.0;

  const emit = (e) => { try { onEvent && onEvent(e); } catch {} };
  const throwIfAborted = () => {
    if (signal && signal.aborted) throw new AbortError();
  };

  let existingDeviceFiles = [];
  try { existingDeviceFiles = await fsp.readdir(devicePath); } catch {}

  const plan = buildPlan({ queue, existingDeviceFiles });
  emit({ type: "plan", plan });

  // Stage: finalise
  emit({ type: "stage", stage: "finalise", state: "active" });
  emit({ type: "stage", stage: "finalise", state: "done" });

  // Stage: delete
  emit({ type: "stage", stage: "delete", state: "active" });
  const newNames = new Set(queue.map((q) => q.filename));
  for (const name of existingDeviceFiles) {
    throwIfAborted();
    if (!isOurFilename(name) || newNames.has(name)) continue;
    emit({ type: "log", stage: "delete", state: "active", text: `rm ${name}` });
    try { await fsp.unlink(path.join(devicePath, name)); }
    catch (e) {
      emit({ type: "log", stage: "delete", state: "error", text: `rm ${name}: ${e.message}` });
      throw e;
    }
    emit({ type: "log", stage: "delete", state: "done", text: `rm ${name}` });
  }
  emit({ type: "stage", stage: "delete", state: "done" });

  // Stage: convert
  emit({ type: "stage", stage: "convert", state: "active" });
  const sources = new Array(queue.length);
  const speedSuffix = needsEncode ? `-speed${String(speed).replace(".", "_")}` : "";
  for (let i = 0; i < queue.length; i++) {
    throwIfAborted();
    const it = queue[i];
    const downloadedPath = path.join(cacheDir, `${it.uuid}.${it.ext || "mp3"}`);
    const isVideo = it.ext && it.ext !== "mp3";
    if (!isVideo && !needsEncode) {
      sources[i] = downloadedPath;
      continue;
    }
    const mp3Path = path.join(cacheDir, `${it.uuid}${speedSuffix}.mp3`);
    let cached = false;
    try { cached = (await fsp.stat(mp3Path)).size > 0; } catch {}
    if (cached) {
      sources[i] = mp3Path;
      emit({ type: "log", stage: "convert", state: "done", uuid: it.uuid, text: `${it.title} · cached` });
      continue;
    }
    emit({ type: "log", stage: "convert", state: "active", uuid: it.uuid, text: it.title });
    await convertFn({
      src: downloadedPath, dest: mp3Path, speed, signal,
      onProgress: ({ seconds, durationSec }) => emit({
        type: "log", stage: "convert", state: "active", uuid: it.uuid, text: it.title,
        bytes: seconds, total: durationSec,
      }),
    });
    sources[i] = mp3Path;
    emit({ type: "log", stage: "convert", state: "done", uuid: it.uuid, text: it.title });
  }
  emit({ type: "stage", stage: "convert", state: "done" });

  // Stage: transfer
  emit({ type: "stage", stage: "transfer", state: "active" });
  const dests = new Array(queue.length);
  for (let i = 0; i < queue.length; i++) {
    throwIfAborted();
    const it = queue[i];
    const dest = path.join(devicePath, it.filename);
    dests[i] = dest;
    emit({ type: "log", stage: "transfer", state: "active", uuid: it.uuid, text: it.filename });
    try {
      await copyFn(sources[i], dest, {
        signal,
        onProgress: ({ bytes, total }) => emit({
          type: "log", stage: "transfer", state: "active", uuid: it.uuid, text: it.filename,
          bytes, total,
        }),
      });
    } catch (e) {
      try { await fsp.unlink(dest); } catch {}
      emit({ type: "log", stage: "transfer", state: "error", uuid: it.uuid, text: `${it.filename}: ${e.message}` });
      throw e;
    }
    emit({ type: "log", stage: "transfer", state: "done", uuid: it.uuid, text: it.filename });
  }
  emit({ type: "stage", stage: "transfer", state: "done" });

  // Stage: verify
  emit({ type: "stage", stage: "verify", state: "active" });
  for (let i = 0; i < queue.length; i++) {
    throwIfAborted();
    const it = queue[i];
    emit({ type: "log", stage: "verify", state: "active", uuid: it.uuid, text: it.filename });
    const [srcHash, dstHash] = await Promise.all([sha256File(sources[i]), sha256File(dests[i])]);
    if (srcHash !== dstHash) {
      emit({ type: "log", stage: "verify", state: "error", uuid: it.uuid, text: `${it.filename} checksum mismatch` });
      throw new Error(`verify failed: checksum mismatch for ${it.filename}`);
    }
    emit({ type: "log", stage: "verify", state: "done", uuid: it.uuid, text: it.filename });
  }
  emit({ type: "stage", stage: "verify", state: "done" });

  emit({ type: "complete", summary: { count: queue.length } });
  return { ok: true, files: dests };
}

module.exports = { runSync, buildPlan, isOurFilename, sha256File, AbortError };
