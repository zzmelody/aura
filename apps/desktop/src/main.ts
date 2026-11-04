import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app, BrowserWindow, dialog, shell } from "electron";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AuraRuntimeHandle } from "@aura/runtime";
import { closeSiteHost, installSiteHost } from "./site-host.ts";
import { installWorkflowFileHost } from "./workflow-file-host.ts";
import { installWindowHost, installWorkbenchBackdrop } from "./window-host.ts";
import { installFileRevealHost } from "./file-reveal-host.ts";
import { startRendererServer } from "./renderer-server.ts";
import { installBrowserHost, registerBrowserOwner } from "./browser-host.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(sourceDir, "..");
const repoRoot = resolve(sourceDir, "..", "..", "..");
const rendererRoot = resolve(appDir, "dist");
let ownedRuntime: AuraRuntimeHandle | null = null;
let runtimeStartup: Promise<void> | undefined;
let renderer: ServerType | null = null;
installSiteHost();
installBrowserHost();
installWorkflowFileHost();
installWindowHost();
installFileRevealHost();
// Renaming Electron on Windows sets isPackaged even through the default loader.
const development =
  process.defaultApp === true && process.argv.includes("--dev");
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

async function runtimeIsRunning(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:4311/health", {
      signal: AbortSignal.timeout(1_500),
    });
    // A 503 from our API means DSH is starting or unavailable, not a free port.
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

/** Reuses a live Aura API, including one whose DSH host is still starting. */
async function ensureRuntime() {
  if (await runtimeIsRunning()) return;
  if (closingServices) return;
  const { startAuraRuntime } = await import("@aura/runtime");
  if (closingServices) return;
  const runtime = await startAuraRuntime({
    root: repoRoot,
    defaultPluginsDirectory: development
      ? resolve(repoRoot, "plugins")
      : resolve(appDir, "dist-host/plugins"),
    host: "127.0.0.1",
    port: 4311,
  });
  if (closingServices) await runtime.close();
  else ownedRuntime = runtime;
  // The API reports DSH readiness itself; the window can already be used.
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

  const running = await startRendererServer(
    rendererApp.fetch,
    resolve(app.getPath("userData"), "Cache", "renderer-port"),
  );
  renderer = running.server;
  return running.url;
}

/** Displays the workbench while its local services warm in parallel. */
async function openWorkbench() {
  const url = await serveRenderer();
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: "#171719",
    title: "Aura",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#b5b5c0",
      height: process.platform === "darwin" ? 48 : 38,
    },
    ...(process.platform === "darwin"
      ? {
          trafficLightPosition: { x: 12, y: 17 },
          vibrancy: "sidebar" as const,
          visualEffectState: "active" as const,
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      preload: resolve(appDir, "dist-host", "preload.cjs"),
    },
  });
  window.setMenu(null);
  installWorkbenchBackdrop(window);
  registerBrowserOwner(window, url);
  runtimeStartup = ensureRuntime().then(() => {
    if (!closingServices) watchBorrowedRuntime();
  });
  void runtimeStartup.catch(() => {
    if (!closingServices)
      dialog.showErrorBox(
        "Aura 服务启动失败",
        "工作台已打开，请检查本地服务后重试。",
      );
  });
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
let runtimeWatch: NodeJS.Timeout | null = null;

/**
 * A runtime this window reused (started by `pnpm dev` or another launcher)
 * can exit while the window stays open. Take over the port when it does, so
 * the workbench is never left without a backend.
 */
function watchBorrowedRuntime() {
  if (ownedRuntime || runtimeWatch) return;
  let checking = false;
  runtimeWatch = setInterval(() => {
    if (checking || ownedRuntime || closingServices) return;
    checking = true;
    void ensureRuntime()
      .catch((error: unknown) =>
        console.error(
          "Aura runtime takeover failed:",
          error instanceof Error ? error.message : error,
        ),
      )
      .finally(() => {
        checking = false;
        if (ownedRuntime && runtimeWatch) {
          clearInterval(runtimeWatch);
          runtimeWatch = null;
        }
      });
  }, 3000);
  runtimeWatch.unref();
}

app.on("before-quit", (event) => {
  if (finishingQuit) return;
  event.preventDefault();
  if (closingServices) return;
  closingServices = true;
  if (runtimeWatch) clearInterval(runtimeWatch);
  renderer?.close();
  void Promise.all([
    closeSiteHost(),
    runtimeStartup?.catch(() => undefined).then(() => ownedRuntime?.close()),
  ])
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
