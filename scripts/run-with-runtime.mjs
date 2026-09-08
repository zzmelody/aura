/** Runs a web surface together with the Aura DSH runtime and cleans up both. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "web" && mode !== "preview")
  throw new Error("Expected web or preview mode.");

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeEntry = fileURLToPath(
  new URL("../apps/server/server.mjs", import.meta.url),
);
const previewEntry = fileURLToPath(new URL("./preview.mjs", import.meta.url));
const pnpmEntry = process.env.npm_execpath;
if (mode === "web" && !pnpmEntry)
  throw new Error("Run this command through pnpm from the repository root.");

/** @returns {Promise<boolean>} */
async function runtimeIsReady() {
  try {
    const response = await fetch("http://127.0.0.1:4311/health", {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.service === "aura-runtime";
  } catch {
    return false;
  }
}

/** @param {import('node:child_process').ChildProcess | null} child */
function stop(child) {
  if (child?.exitCode === null) child.kill();
}

let runtime = null;
if (!(await runtimeIsReady())) {
  runtime = spawn(process.execPath, [runtimeEntry], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await runtimeIsReady()) break;
    if (runtime.exitCode !== null)
      throw new Error(`Aura runtime exited with code ${runtime.exitCode}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!(await runtimeIsReady())) {
    stop(runtime);
    throw new Error("Aura runtime did not become ready on port 4311.");
  }
}

const surface =
  mode === "preview"
    ? spawn(process.execPath, [previewEntry], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      })
    : spawn(process.execPath, [pnpmEntry, "--filter", "@aura/mobile", "run", "web"], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      });

let closing = false;
let launcherWatch = null;
function close() {
  if (closing) return;
  closing = true;
  if (launcherWatch) clearInterval(launcherWatch);
  stop(surface);
  stop(runtime);
}
const launcherPid = Number(process.env.AURA_LAUNCHER_PID ?? process.ppid);
launcherWatch = setInterval(() => {
  try {
    process.kill(launcherPid, 0);
  } catch {
    close();
    process.exit(0);
  }
}, 1000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    close();
    process.exitCode = 0;
  });

const exitCode = await new Promise((resolve, reject) => {
  surface.once("error", reject);
  surface.once("exit", (code) => resolve(code ?? 1));
});
close();
process.exitCode = exitCode;
