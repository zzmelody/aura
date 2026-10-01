/** Explicit read-only acceptance monitor; no native calls or timing controls. */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FlowRun } from "@aura/protocol/types";
import { activePerformance } from "./performance-watch-support.ts";

const [root, runId] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !runId || !/^[a-f0-9-]{36}$/u.test(runId)) throw new Error("Usage: watch-performance.ts <absolute acceptance root> <root Run ID>");
const directory = join(root, ".aura/creator-acceptance"), evidence = join(directory, "evidence");
const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8")), base = new URL(runtime.url);
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.port !== "4312") throw new Error("Only the isolated 4312 acceptance runtime may be observed");
const get = async (id: string): Promise<FlowRun> => {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error("Invalid Run identity");
  const response = await fetch(new URL("/flows/runs/" + id, base), { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error("Run observation HTTP " + response.status);
  const value = await response.json() as any, run = (value.run ?? value) as FlowRun;
  if (run.id !== id) throw new Error("Run observation identity changed");
  // CLI status owns run-*.json. Keep concurrent observation snapshots separate.
  await writeFile(join(evidence, `watch-run-${id}.json`), JSON.stringify(run, null, 2), { mode: 0o600 });
  return run;
};
const emitted = new Set<string>(), deadline = Date.now() + 60 * 60 * 1000;
watch: while (Date.now() < deadline) {
  const rootRun = await get(runId), observedAt = new Date().toISOString();
  if (["completed", "failed", "cancelled"].includes(rootRun.status)) {
    console.log(JSON.stringify({ kind: "root_terminal", rootRunId: runId, status: rootRun.status, observedAt }));
    break;
  }
  for (const notice of await activePerformance(rootRun, get)) {
    const key = notice.kind + ":" + notice.runId + ":" + (notice.stepKey ?? "");
    if (emitted.has(key)) continue;
    emitted.add(key);
    const line = JSON.stringify({ ...notice, observedAt: new Date().toISOString(), pollIntervalMs: 1000 });
    await appendFile(join(evidence, `performance-watch-${runId}.jsonl`), line + "\n", { mode: 0o600 });
    console.log(line);
    if (notice.kind === "performance_running" || notice.kind === "performance_missed") break watch;
  }
  await delay(1000);
}
