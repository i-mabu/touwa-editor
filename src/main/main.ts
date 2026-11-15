import { app, BrowserWindow, session, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerIpc } from "./ipc/register-ipc";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#10141c",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererPath = path.join(__dirname, "../renderer/index.html");
  // The Renderer may only ever display the dev server or its own
  // bundled page. setWindowOpenHandler covers window.open, but not
  // in-page navigation (a link click or location change in compromised
  // content could otherwise take the window to a remote site that
  // still sees the preload bridge's page context).
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = devServerUrl
      ? url.startsWith(devServerUrl)
      : url === pathToFileURL(rendererPath).href;
    if (!allowed) event.preventDefault();
  });
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    // loadFile handles platform path separators; a hand-built
    // `file://${path.join(...)}` URL is malformed on Windows.
    void window.loadFile(rendererPath);
  }
}
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
