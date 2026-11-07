import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { desktopExecutable } from "./desktop-bundle.ts";
import {
  createDevToken,
  devInstanceFile,
  devShutdown,
  launcherProcesses,
  processAlive,
  reclaimDevPort,
  removeDevInstance,
  writeDevInstance,
} from "./dev-instance.ts";
import { modelViewerAssets } from "./model-viewer-assets.ts";
import { liveReloadFallback } from "./vite-live-reload.ts";

const target = process.argv[2];
if (target !== "web" && target !== "desktop" && target !== "mobile")
  throw new Error("Usage: dev-renderer.ts <web|desktop|mobile>");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(root, "apps", target);
const token = createDevToken();
const server = await createServer({
  root: appRoot,
  configFile: resolve(appRoot, "vite.config.ts"),
  plugins: [
    liveReloadFallback(),
    modelViewerAssets(),
    devShutdown(token, () => void close().finally(() => process.exit(0))),
  ],
  ...(target === "mobile" ? { server: { host: "0.0.0.0", port: 8082 } } : {}),
});
const port = server.config.server.port ?? 5173;
const instanceFile = devInstanceFile(target, port);
const watched = await launcherProcesses();
const parentWatch = setInterval(() => {
  const gone = watched.find((pid) => !processAlive(pid));
  if (gone === undefined) return;
  console.log(
    `Launcher process ${gone} exited; stopping the ${target} dev server.`,
  );
  void close().finally(() => process.exit(0));
}, 1000);
parentWatch.unref();
let desktop: ChildProcess | undefined;
let closing: Promise<void> | undefined;

function close() {
  return (closing ??= (async () => {
    clearInterval(parentWatch);
    if (desktop?.exitCode === null) desktop.kill();
    await server.close();
    await removeDevInstance(instanceFile, token);
  })());
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void close().finally(() => process.exit(0)));

try {
  if (!(await reclaimDevPort(port, instanceFile)))
    throw new Error(
      `Port ${port} is in use by a process that is not an Aura ${target} dev server. Stop it and retry.`,
    );
  await server.listen();
  await writeDevInstance(instanceFile, { pid: process.pid, token });
  server.printUrls();
  if (target === "desktop") {
    const executable = await desktopExecutable();
    // An inherited ELECTRON_RUN_AS_NODE (set by some IDE and agent hosts)
    // would start Electron as plain Node, without its `app` and window APIs.
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
    desktop = spawn(executable, [".", "--dev"], {
      cwd: appRoot,
      stdio: "inherit",
      // No windowsHide: spawning the desktop executable would pass SW_HIDE to
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
