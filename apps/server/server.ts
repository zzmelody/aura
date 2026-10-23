/** Standalone server application output for the reusable Aura backend runtime. */
import { startAuraRuntime } from "@aura/runtime";

const bundledPlugins = process.env.AURA_BUNDLED_PLUGINS;
const runtime = await startAuraRuntime({
  ...(bundledPlugins ? { defaultPluginsDirectory: bundledPlugins } : {}),
});
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

try {
  await runtime.ready();
  if (!closing) {
    console.log(`Aura runtime: ${runtime.url} (DSH ready)`);
    // Never announce readiness while the API is up but DSH is unavailable.
    console.log(`AURA_READY ${runtime.url}`);
  }
} catch {
  const cancelled = closing;
  await close();
  if (!cancelled) {
    console.error(
      "Aura DSH startup failed; check .aura/dsh/logs/aura-host.log.",
    );
    process.exitCode = 1;
  }
}
