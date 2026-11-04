import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { desktopExecutable } from "./desktop-bundle.ts";
import { modelViewerAssets } from "./model-viewer-assets.ts";
import { liveReloadFallback } from "./vite-live-reload.ts";

const target = process.argv[2];
if (target !== "web" && target !== "desktop" && target !== "mobile")
  throw new Error("Usage: dev-renderer.ts <web|desktop|mobile>");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(root, "apps", target);
const server = await createServer({
  root: appRoot,
  configFile: resolve(appRoot, "vite.config.ts"),
  plugins: [liveReloadFallback(), modelViewerAssets()],
  ...(target === "mobile" ? { server: { host: "0.0.0.0", port: 8082 } } : {}),
});
let desktop: ChildProcess | undefined;
let closing: Promise<void> | undefined;

function close() {
  return (closing ??= (async () => {
    clearInterval(parentWatch);
    if (desktop?.exitCode === null) desktop.kill();
    await server.close();
  })());
}

const parentPid = Number(process.env.AURA_LAUNCHER_PID ?? process.ppid);
const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    void close().finally(() => process.exit(0));
  }
}, 1000);
parentWatch.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void close().finally(() => process.exit(0)));

try {
  await server.listen();
  server.printUrls();
  if (target === "desktop") {
    // A renamed bundle on macOS, so the Dock shows "Aura" instead of "Electron".
    const electron = await desktopExecutable();
    // An inherited ELECTRON_RUN_AS_NODE (set by some IDE and agent hosts)
    // would start Electron as plain Node, without its `app` and window APIs.
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
    desktop = spawn(electron, [".", "--dev"], {
      cwd: appRoot,
      stdio: "inherit",
      // No windowsHide: spawning electron.exe directly would pass SW_HIDE to
      // its first window on Windows, leaving the workbench invisible.
      env: { ...env, AURA_DEV_PARENT_PID: String(process.pid) },
    });
    desktop.once("error", (error) => {
      console.error(error.message);
      void close().finally(() => process.exit(1));
    });
    desktop.once("exit", (code) => {
      void close().finally(() => process.exit(code ?? 0));
    });
  }
} catch (error) {
  await close();
  throw error;
}
