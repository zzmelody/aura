/** Standalone server application output for the reusable Aura backend runtime. */
import { startAuraRuntime } from "@aura/runtime";

const runtime = await startAuraRuntime();
console.log(
  `Aura runtime: ${runtime.url} (DSH demo + DSH Codex subscription + Tripo 3D)`,
);
// Machine-readable readiness for launchers such as the Veya game.
console.log(`AURA_READY ${runtime.url}`);

let closing = false;
const launcherPid = Number(process.env.AURA_LAUNCHER_PID ?? process.ppid);
const launcherWatch = setInterval(() => {
  try {
    process.kill(launcherPid, 0);
  } catch {
    void close();
  }
}, 1000);

async function close() {
  if (closing) return;
  closing = true;
  clearInterval(launcherWatch);
  process.exitCode = 0;
  try {
    await runtime.close();
  } catch (error) {
    console.error(
      "Aura runtime shutdown failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close();
  });
