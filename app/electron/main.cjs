const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");

// Repair PATH before anything spawns a subprocess. A Finder/Spotlight-launched
// .app inherits a stripped PATH and would otherwise fail to find `uv`
// (fast-diarise), the qwen-speak venv tools, etc., silently degrading every smart
// step to "skipped". No-op when launched from a terminal.
const { fixEnv } = require("./fixEnv.cjs");
fixEnv();

app.setPath("userData", path.join(app.getPath("appData"), "openswim-podcast"));

// Point the diagnostics logger at a file in userData so silent skips (no
// transcript, TTS failure, detector unreachable) leave a trail. Path is shown to
// the user in the app's About/help if they need to find it.
process.env.OSW_LOG = path.join(app.getPath("userData"), "openswim.log");

const { logEvent } = require("./logger.cjs");
logEvent("startup", `Open Swimcast ${app.getVersion()} - packaged=${app.isPackaged}`);
logEvent("startup", `PATH=${process.env.PATH}`);

const { registerPocketCasts } = require("./ipc.cjs");

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1C110E",
    icon: path.join(__dirname, "..", "public", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  registerPocketCasts();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
