/** Standalone server application output for the reusable Aura backend runtime. */
import { startAuraRuntime } from "@aura/runtime";

const runtime = await startAuraRuntime();
console.log(
  `Aura runtime: ${runtime.url} (DSH demo + DSH Codex subscription)`,
);

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
    console.error("Aura runtime shutdown failed:", error.message);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close();
  });
