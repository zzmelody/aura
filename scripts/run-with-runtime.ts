/** Runs a web surface together with the Aura DSH runtime and cleans up both. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "web" && mode !== "preview")
  throw new Error("Expected web or preview mode.");

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeEntry = fileURLToPath(
  new URL("../apps/server/server.ts", import.meta.url),
);
const previewEntry = fileURLToPath(new URL("./preview.ts", import.meta.url));
const rendererEntry = fileURLToPath(
  new URL("./dev-renderer.ts", import.meta.url),
);

async function runtimeStatus(): Promise<
  "ready" | "starting" | "unavailable" | undefined
> {
  try {
    const response = await fetch("http://127.0.0.1:4311/health", {
      signal: AbortSignal.timeout(1_500),
    });
    const body = (await response.json()) as unknown;
    if (!(
      typeof body === "object" &&
      body !== null &&
      "service" in body &&
      body.service === "aura-runtime"
    ))
      return undefined;
    return response.ok
      ? "ready"
      : "status" in body && body.status === "starting"
        ? "starting"
        : "unavailable";
  } catch {
    return undefined;
  }
}

function stop(child: ChildProcess | null): void {
  if (child?.exitCode === null) child.kill();
}

let runtime: ChildProcess | null = null;
if (!(await runtimeStatus())) {
  runtime = spawn(process.execPath, ["--import", "tsx", runtimeEntry], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
}
try {
  const deadline = Date.now() + 130_000;
  let status = await runtimeStatus();
  while (status !== "ready") {
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(
        "Aura runtime exited before DSH became ready. Check .aura/dsh/logs/aura-host.log.",
      );
    if (status === "unavailable" || Date.now() >= deadline)
      throw new Error(
        "Aura DSH is unavailable. Check .aura/dsh/logs/aura-host.log.",
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await runtimeStatus();
  }
} catch (error) {
  stop(runtime);
  throw error;
}

const surface =
  mode === "preview"
    ? spawn(process.execPath, ["--import", "tsx", previewEntry], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      })
    : spawn(process.execPath, ["--import", "tsx", rendererEntry, "web"], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      });

let closing = false;
let launcherWatch: NodeJS.Timeout | null = null;
function close(): void {
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

const exitCode = await new Promise<number>((resolve, reject) => {
  surface.once("error", reject);
  surface.once("exit", (code) => resolve(code ?? 1));
});
close();
process.exitCode = exitCode;
