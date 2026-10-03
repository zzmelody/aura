import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app, BrowserWindow, dialog, shell } from "electron";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { startAuraRuntime } from "@aura/runtime";
import { closeSiteHost, installSiteHost } from "./site-host.ts";
import { installWorkflowFileHost } from "./workflow-file-host.ts";
import { installWindowHost } from "./window-host.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(sourceDir, "..");
const repoRoot = resolve(sourceDir, "..", "..", "..");
const rendererRoot = resolve(appDir, "dist");
let ownedRuntime: Awaited<ReturnType<typeof startAuraRuntime>> | null = null;
let renderer: ServerType | null = null;
installSiteHost();
installWorkflowFileHost();
installWindowHost();
const development = !app.isPackaged && process.argv.includes("--dev");
if (development) {
  const parentPid = Number(process.env.AURA_DEV_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const parentWatch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        app.quit();
      }
    }, 1000);
    parentWatch.unref();
    app.once("will-quit", () => clearInterval(parentWatch));
  }
}

async function runtimeIsReady(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:4311/health", {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as unknown;
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

async function serveRenderer(): Promise<string> {
  if (development) {
    return "http://127.0.0.1:8082";
  }
  const rendererApp = new Hono();
  rendererApp.use("*", secureHeaders());
  rendererApp.use("*", async (context, next) => {
    context.header("Cache-Control", "no-cache");
    await next();
  });
  rendererApp.get(
    "/*",
    serveStatic({
      root: rendererRoot,
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  );
  rendererApp.notFound((context) => context.text("Not found", 404));

  const port = await new Promise<number>((resolvePort, reject) => {
    renderer = serve(
      {
        fetch: rendererApp.fetch,
        hostname: "127.0.0.1",
        port: 0,
      },
      (info) => resolvePort(info.port),
    );
    renderer.once("error", reject);
  });
  return `http://127.0.0.1:${port}`;
}

/** Opens the Aura renderer after its local services are ready. */
async function openWorkbench() {
  await ensureRuntime();
  const url = await serveRenderer();
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: "#171719",
    title: "Aura",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1d1d20", symbolColor: "#b5b5c0", height: 38 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(appDir, "dist-host", "preload.cjs"),
    },
  });
  window.setMenu(null);
  window.webContents.on("preload-error", (_event, _path, error) => {
    console.error("Aura desktop bridge failed to load:", error.message);
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
let closingServices = false;
app.on("before-quit", (event) => {
  if (finishingQuit) return;
  event.preventDefault();
  if (closingServices) return;
  closingServices = true;
  renderer?.close();
  void Promise.all([closeSiteHost(), ownedRuntime?.close()])
    .then(() => {
      finishingQuit = true;
      app.quit();
    })
    .catch((error) => {
      closingServices = false;
      dialog.showErrorBox(
        "Aura 退出清理失败",
        error instanceof Error ? error.message : "请重试退出。",
      );
    });
});
app.on("will-quit", () => renderer?.close());
app
  .whenReady()
  .then(openWorkbench)
  .catch((error) => {
    dialog.showErrorBox(
      "Aura 无法启动",
      error instanceof Error ? error.message : "桌面服务启动失败。",
    );
    app.quit();
  });
