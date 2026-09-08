import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";
import { startAuraRuntime } from "@aura/runtime";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(sourceDir, "..");
const repoRoot = resolve(sourceDir, "..", "..", "..");
const rendererRoot = resolve(appDir, "dist");
/** @type {Awaited<ReturnType<typeof startAuraRuntime>> | null} */
let ownedRuntime = null;
/** @type {import('node:http').Server | null} */
let renderer = null;

/** @returns {Promise<boolean>} */
async function runtimeIsReady() {
  try {
    const response = await fetch("http://127.0.0.1:4311/health", {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    /** @type {unknown} */
    const body = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "service" in body &&
      body.service === "aura-runtime"
    );
  } catch {
    return false;
  }
}

/** Starts the DSH runtime only when another Aura runtime is not already ready. */
async function ensureRuntime() {
  if (await runtimeIsReady()) return;
  ownedRuntime = await startAuraRuntime({
    root: repoRoot,
    host: "127.0.0.1",
    port: 4311,
  });
  if (!(await runtimeIsReady()))
    throw new Error("Aura runtime did not become ready on port 4311.");
}

/** @type {Record<string, string>} */
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** @returns {Promise<string>} */
async function serveRenderer() {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const pathname = decodeURIComponent(
        new URL(req.url ?? "/", "http://localhost").pathname,
      );
      let file = resolve(rendererRoot, "." + pathname);
      if (file !== rendererRoot && !file.startsWith(rendererRoot + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (pathname === "/") file = resolve(rendererRoot, "index.html");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).pipe(res);
    } catch {
      res.writeHead(400).end("Invalid request");
    }
  });
  renderer = server;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () =>
      resolveListen(undefined),
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Desktop renderer did not expose a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

/** Opens the Aura renderer after its local services are ready. */
async function openWorkbench() {
  await ensureRuntime();
  const url = await serveRenderer();
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: "#0C0B10",
    title: "Aura",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url: requested }) => {
    if (requested === "about:blank")
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 560,
          height: 760,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    if (requested.startsWith("https://")) void shell.openExternal(requested);
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (child) => {
    child.webContents.on("will-navigate", (event, requested) => {
      if (!requested.startsWith("https://")) return;
      event.preventDefault();
      void shell.openExternal(requested);
      child.close();
    });
  });
  await window.loadURL(url);
}

app.on("window-all-closed", () => app.quit());
let finishingQuit = false;
app.on("before-quit", (event) => {
  if (finishingQuit || !ownedRuntime) return;
  event.preventDefault();
  finishingQuit = true;
  renderer?.close();
  void ownedRuntime.close().finally(() => app.quit());
});
app.on("will-quit", () => renderer?.close());
app.whenReady().then(openWorkbench).catch((error) => {
  dialog.showErrorBox(
    "Aura 无法启动",
    error instanceof Error ? error.message : "桌面服务启动失败。",
  );
  app.quit();
});
