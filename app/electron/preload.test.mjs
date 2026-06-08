import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Module } from "node:module";

// preload.cjs does `require("electron")` and calls contextBridge.exposeInMainWorld
// at load, which throws outside the Electron runtime. To unit-test the renderer
// bridge we evaluate the module source in a fresh CommonJS wrapper with a STUBBED
// `electron` require, capturing the exposed API and recording every
// ipcRenderer.invoke call so we can assert the forwarded payload per channel.
const here = path.dirname(fileURLToPath(import.meta.url));
const preloadSrc = fs.readFileSync(path.join(here, "preload.cjs"), "utf8");
const baseRequire = createRequire(import.meta.url);

function loadPreload() {
  const calls = [];
  let exposed = null;
  const electronStub = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: {
      invoke: (channel, arg) => { calls.push({ channel, arg }); return Promise.resolve(); },
      on: () => {},
      removeListener: () => {},
    },
  };
  const fakeRequire = (id) => (id === "electron" ? electronStub : baseRequire(id));
  const m = { exports: {} };
  const wrapper = Module.wrap(preloadSrc);
  // eslint-disable-next-line no-eval
  const fn = eval(wrapper);
  fn(m.exports, fakeRequire, m, path.join(here, "preload.cjs"), here);
  return { calls, exposed };
}

describe("preload trim bridge", () => {
  let calls, exposed;
  beforeEach(() => { ({ calls, exposed } = loadPreload()); });

  it("trim.decide forwards uuid, cut, decision AND ext", () => {
    exposed.trim.decide("u1", { startSec: 600, endSec: 700 }, "remove", "m4a");
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("trim:decide");
    expect(calls[0].arg).toEqual({
      uuid: "u1", cut: { startSec: 600, endSec: 700 }, decision: "remove", ext: "m4a",
    });
  });

  // Regression: preload previously dropped `ext` for trim.edit, so an
  // edit-after-decide for a non-mp3 episode persisted the adjusted boundaries to a
  // defaulted .mp3 sidecar path. A later re-process then missed the adjusted
  // decision. The renderer MUST forward `ext` so ipc.cjs persists to the right
  // fingerprint sidecar.
  it("trim.edit forwards uuid, originalCut, newCut AND ext (so the right sidecar is written)", () => {
    exposed.trim.edit(
      "u1",
      { startSec: 600, endSec: 700 },
      { startSec: 615, endSec: 690 },
      "m4a",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("trim:edit");
    expect(calls[0].arg).toEqual({
      uuid: "u1",
      originalCut: { startSec: 600, endSec: 700 },
      newCut: { startSec: 615, endSec: 690 },
      ext: "m4a",
    });
  });
});
