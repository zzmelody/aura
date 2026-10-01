/** Explicit real-runtime acceptance harness. Never imported by production. */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FlowRun } from "@aura/protocol/types";
import { startAuraRuntime } from "../../src/index.ts";
import { retainedPropWork } from "../../src/veya-creator-recovery.ts";
import { retainedWorldDesign } from "../../src/veya-creator-world-design-recovery.ts";
import { importPreparationReconciliation } from "../../src/veya-creator-reconciliation.ts";

type Data = Record<string, any>; // Test JSON; production boundaries still validate schemas.
async function main(): Promise<void> {
const args = process.argv.slice(2), command = args.shift();
const flags = new Map<string, string>();
while (args.length) {
  const key = args.shift()!, value = args.shift();
  if (!key.startsWith("--") || value === undefined || flags.has(key)) throw new Error("Use unique --name value pairs");
  flags.set(key, value);
}
if (command === "help" || !command) {
  console.log("Commands: serve, stop, catalog, prepare, register, submit, status, answer, cancel, resume, paid, recovery, reconcile-preparation, artifact-proof. See README.md.");
  return;
}
const required = (name: string) => { const value = flags.get(name); if (!value) throw new Error(`Required: ${name}`); return value; };
const absolute = (name: string) => { const value = required(name); if (!isAbsolute(value)) throw new Error(`${name} must be absolute`); return resolve(value); };
const root = absolute("--root"), directory = join(root, ".aura", "creator-acceptance"), evidence = join(directory, "evidence");
await mkdir(evidence, { recursive: true });
const read = async <T = Data>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8"));
const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stamp = () => new Date().toISOString().replace(/[:.]/gu, "-");
const currentPath = join(directory, "current.json"), authPath = join(directory, "client.json"), stopPath = join(directory, "stop");
async function json(url: string, body?: unknown, token?: string): Promise<Data> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const result = await response.json() as Data;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(result.error ?? "request_failed")}`);
  return result;
}
if (command === "serve") {
  const plugin = absolute("--plugin"), port = Number(flags.get("--port") ?? 4312);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
  const configPath = join(directory, "plugins.json");
  await write(configPath, { version: 1, plugins: [{ path: plugin, enabled: true, trust: "local" }] });
  const runtime = await startAuraRuntime({ root, host: "127.0.0.1", port, pluginConfigPath: configPath,
    worldAgentSessionPath: join(directory, "no-default-foreground.json") });
  await write(join(directory, "runtime.json"), { pid: process.pid, url: runtime.url, startedAt: new Date().toISOString() });
  console.log(JSON.stringify({ status: "ready", url: runtime.url }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; clearInterval(watch); await runtime.close(); };
  const watch = setInterval(() => void access(stopPath).then(async () => { await unlink(stopPath); await close(); }).catch(() => undefined), 1000);
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
} else if (command === "stop") {
  await writeFile(stopPath, "stop", { mode: 0o600 }); console.log("Stop requested for this acceptance root");
} else if (command === "catalog") {
  const runtime = await read(join(directory, "runtime.json")), catalog = await json(runtime.url + "/flows/catalog");
  const entries = [...(catalog.flows ?? []), ...(catalog.actions ?? [])].filter((item: Data) => String(item.id).startsWith("veya/"));
  await write(join(evidence, `catalog-${stamp()}.json`), catalog);
  console.log(JSON.stringify({ contributions: entries.length, entries: entries.map((item: Data) => ({ id: item.id, available: item.available, sourceHash: item.sourceHash })) }));
  if (!entries.length || entries.some((item: Data) => item.available !== true)) throw new Error("Veya contributions are unavailable");
} else if (command === "prepare") {
  const fixture = await read(absolute("--case")), identity = await read(absolute("--identity"));
  if (typeof identity.playerId !== "string" || typeof identity.homeWorldId !== "string") throw new Error("Identity requires playerId and homeWorldId");
  const request: Data = { ...fixture, requestId: flags.get("--request-id") ?? randomUUID() };
  if (flags.has("--previous-request")) request.previousRequestId = required("--previous-request");
  if (flags.has("--previous-artifact")) request.previousArtifactId = required("--previous-artifact");
  if (flags.has("--reuse-assets-from-request")) request.reuseAssetsFromRequestId = required("--reuse-assets-from-request");
  if (flags.has("--reuse-production-from-request")) request.reuseProductionFromRequestId = required("--reuse-production-from-request");
  if (flags.has("--grant")) request.artifactTarget = await read(absolute("--grant"));
  if (flags.has("--target")) {
    if (flags.has("--grant")) throw new Error("Use either --target for an existing saved world or --grant for a new checkout");
    request.target = await read(absolute("--target"));
  }
  if (JSON.stringify({ request, identity }).includes("REPLACE_")) throw new Error("Replace template placeholders with verified opaque IDs");
  await write(currentPath, { request, identity });
  console.log(JSON.stringify({ requestId: request.requestId, operation: request.operation, prepared: true }));
} else {
  const current = await read(currentPath), request = current.request as Data;
  const runtime = await read(join(directory, "runtime.json"));
  if (command === "submit" || command === "register") {
    const service = await read(join(root, ".aura", "veya-creator", "session.json"));
    const client = await json(service.base_url + "clients", { ...current.identity, workerSessionPath: absolute("--worker") }, service.token);
    await write(authPath, { base: service.base_url, token: client.token });
    if (command === "register") {
      console.log(JSON.stringify({ registered: true, requestId: request.requestId, submitted: false }));
      return;
    }
    const result = await json(service.base_url + "tasks", request, client.token);
    await write(join(evidence, `request-${request.requestId}.json`), { ...request, ...result });
    let watchConcurrent = false;
    let concurrentExit: Promise<void> | undefined;
    if (flags.has("--concurrent-test")) {
      const test = await read(absolute("--concurrent-test"));
      if (typeof result.runId !== "string" || typeof test.command !== "string" || !isAbsolute(test.command) ||
          typeof test.cwd !== "string" || !isAbsolute(test.cwd) || !Array.isArray(test.args) ||
          test.args.some((arg: unknown) => typeof arg !== "string")) throw new Error("Invalid explicit concurrent test launcher");
      const launchPath = join(evidence, `concurrent-${result.runId}.json`);
      let claimed = true;
      try { await writeFile(launchPath, JSON.stringify({ runId: result.runId, status: "starting", observedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") claimed = false; else throw error; }
      if (claimed) {
        const stdout = openSync(join(evidence, `concurrent-${result.runId}.stdout.log`), "a"),
          stderr = openSync(join(evidence, `concurrent-${result.runId}.stderr.log`), "a");
        try {
          const child = spawn(test.command, test.args.map((arg: string) => arg.replaceAll("{runId}", result.runId)), {
            cwd: test.cwd, shell: false, windowsHide: true, stdio: ["ignore", stdout, stderr],
          });
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
            child.once("exit", (code, signal) => resolve({ code, signal }));
          });
          await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
          const launch = { runId: result.runId, pid: child.pid, launchedAt: new Date().toISOString() };
          await write(launchPath, { ...launch, status: "launched" });
          // Detached PowerShell can exit before evaluating -File on Windows.
          // Keep this explicitly requested test child owned until its real exit.
          concurrentExit = exited.then(async ({ code, signal }) => {
            await write(launchPath, { ...launch, status: "exited", exitCode: code, signal, exitedAt: new Date().toISOString() });
          });
          watchConcurrent = true;
        } finally { closeSync(stdout); closeSync(stderr); }
      }
    }
    console.log(JSON.stringify(result));
    if (watchConcurrent) {
      // Keep an independent UTC projection trail while the native foreground
      // harness runs. These reads touch Aura durable state, never Veya GPU work.
      const active = async (id: string, depth = 0): Promise<string> => {
        if (depth > 8) throw new Error("Invalid Run depth");
        const value = await json(runtime.url + "/flows/runs/" + id), run = (value.run ?? value) as FlowRun;
        const child = run.steps.find(step => step.kind === "flow" && step.status === "running" && step.childRunId);
        return child?.kind === "flow" && child.childRunId ? active(child.childRunId, depth + 1) : run.flow.id;
      };
      const until = Date.now() + 65_000;
      while (Date.now() < until) {
        const projection = await json(service.base_url + "tasks/" + request.requestId, undefined, client.token);
        await write(join(evidence, `projection-${stamp()}.json`), { ...projection, testObservedAt: new Date().toISOString(),
          testActiveFlow: await active(result.runId) });
        await delay(1000);
      }
      await concurrentExit;
    }
  } else {
    const auth = await read(authPath), url = auth.base + "tasks/" + request.requestId;
    const getRun = async (id: string): Promise<FlowRun> => {
      if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error("Invalid Run identity");
      if (flags.has("--saved-evidence")) return read<FlowRun>(join(absolute("--saved-evidence"), `run-${id}.json`));
      const value = await json(runtime.url + "/flows/runs/" + id); return (value.run ?? value) as FlowRun;
    };
    if (command === "status") {
      const projection = await json(url, undefined, auth.token), rows: Data[] = [], seen = new Set<string>();
      const observedAt = new Date().toISOString();
      const visit = async (id: string, depth: number) => {
        if (depth > 8 || seen.size >= 64 || seen.has(id)) throw new Error("Invalid Run tree");
        seen.add(id); const run = await getRun(id);
        await write(join(evidence, `run-${id}.json`), run);
        rows.push({ id, depth, flow: run.flow.id, status: run.status, active: run.steps.filter(step => !["completed", "skipped"].includes(step.status))
          .map(step => ({ id: step.id, kind: step.kind, status: step.status })), domainStatus: (run.output as Data | undefined)?.status });
        for (const step of run.steps) if (step.kind === "flow" && step.childRunId) await visit(step.childRunId, depth + 1);
      };
      if (projection.runId) await visit(projection.runId, 0);
      const running = rows.filter(row => row.status === "running").sort((a, b) => b.depth - a.depth)[0];
      await write(join(evidence, `projection-${stamp()}.json`), { ...projection, testObservedAt: observedAt,
        ...(running ? { testActiveFlow: running.flow } : {}) });
      console.log(JSON.stringify({ projection, runs: rows }));
    } else if (command === "answer") {
      console.log(JSON.stringify(await json(url + "/answer", await read(absolute("--answer")), auth.token)));
    } else if (command === "cancel" || command === "resume") {
      console.log(JSON.stringify(await json(url + "/" + command, { commandId: required("--command-id") }, auth.token)));
    } else if (command === "recovery" || command === "reconcile-preparation") {
      const document = await read(join(root, ".aura", "veya-creator", "bindings.json"));
      const id = flags.get("--source-request") ?? request.requestId, binding = document.bindings[id];
      if (!binding?.runId) throw new Error("Unknown source binding");
      if (binding.input?.operation === "create_world") {
        if (command !== "recovery") throw new Error("Preparation reconciliation requires a prop task");
        const result = await retainedWorldDesign(await getRun(binding.runId), id, getRun, binding.worldDesignRecovery);
        await write(join(evidence, `world-design-recovery-${id}.json`), result);
        console.log(JSON.stringify({ sourceRequestId: id, sourceRunId: result.sourceRunId,
          draftHash: result.draftHash, formatCorrectionUsed: result.formatCorrectionUsed }));
        return;
      }
      const result = await retainedPropWork(await getRun(binding.runId), id, binding.recoveryBudgetCreationId ?? id, root, getRun, binding.recovery);
      if (command === "reconcile-preparation") {
        const sessionPath = absolute("--worker"), worker = await read(sessionPath);
        const address = new URL(worker.base_url);
        if (resolve(binding.sessionPath) !== sessionPath || worker.creation_session_id !== binding.creationSessionId ||
            worker.role !== "creator-worker" || address.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(address.hostname))
          throw new Error("Reconciliation requires the exact bound worker");
        const response = await json(new URL("/agent/v1/call", address).href,
          { tool: "veya.assets.list", arguments: {} }, worker.token);
        if (response.ok !== true) throw new Error("Registered asset catalog unavailable");
        const catalog = response.data, preparation = result.preparation as Data, operation = result.preparedOperation as Data;
        if (!preparation || !operation) throw new Error("Successful preparation receipt and durable operation required");
        const requirementId = required("--requirement"), raw = preparation.sourceBindings.find((b: Data) => b.requirementId === requirementId),
          prepared = preparation.preparedBindings.find((b: Data) => b.requirementId === requirementId);
        if (!raw || !prepared) throw new Error("Unknown prepared requirement");
        const mapping = await read<Data[]>(absolute("--host-files")), sources = [];
        for (const [role, assetId, contentHash] of [["raw", raw.assetId, raw.version], ["visual", prepared.assetId, prepared.version],
          ["collision", prepared.collisionAssetId, prepared.collisionVersion]] as const) {
          const matches = mapping.filter(entry => entry.id === assetId), currentAsset = catalog[assetId];
          if (matches.length !== 1 || !currentAsset || currentAsset.content_hash !== contentHash) throw new Error("Registered resource identity changed");
          const file = matches[0]!, resourcePath = currentAsset.path;
          if (typeof resourcePath !== "string" || !resourcePath.startsWith("res://assets/generated/") || file.res_path !== resourcePath ||
              file.sha256 !== contentHash || file.catalog_hash !== contentHash ||
              resolve(file.path) !== resolve(dirname(sessionPath), "cooker", "jobs", operation.operationId, "project", resourcePath.slice(6)))
            throw new Error("Resource bytes must come from the exact admitted Cooker workspace");
          const bytes = await readFile(file.path); if (hash(bytes) !== contentHash) throw new Error("Registered resource bytes changed");
          sources.push({ role, assetId, contentHash, resourcePath, bytes });
        }
        const runs: FlowRun[] = [], visit = async (runId: string) => {
          if (runs.some(run => run.id === runId) || runs.length >= 64) throw new Error("Invalid durable tree");
          const run = await getRun(runId); runs.push(run);
          for (const step of run.steps) if (step.kind === "flow" && step.childRunId) await visit(step.childRunId);
        };
        await visit(binding.runId);
        await importPreparationReconciliation(root, result, runs, required("--candidate"), requirementId,
          await readFile(absolute("--report")), sources);
        const admitted = await retainedPropWork(await getRun(binding.runId), id, binding.recoveryBudgetCreationId ?? id, root, getRun, binding.recovery);
        await write(join(evidence, `recovery-${id}.json`), admitted);
        console.log(JSON.stringify({ sourceRequestId: id, preparationDefects: admitted.preparationDefects, noNewPaidWork: admitted.noNewPaidWork,
          repairRound: admitted.repairRound }));
        return;
      }
      await write(join(evidence, `recovery-${id}.json`), result);
      console.log(JSON.stringify({ sourceRequestId: id, sourceRunId: result.sourceRunId, noNewPaidWork: result.noNewPaidWork, repairRound: result.repairRound }));
    } else if (command === "paid") {
      const ledger = await read(join(root, ".aura", "world-agent-paid.json")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!ledger) {
        // A new root that stopped before asset work may never create a ledger.
        // Absence alone is not proof of zero supplier side effects; inspect the Run tree too.
        const result = { observedAt: new Date().toISOString(), ledgerStatus: "not_created", requests: [] };
        await write(join(evidence, `paid-${stamp()}.json`), result); console.log(JSON.stringify(result));
        return;
      }
      const requests = Object.entries(ledger.requests as Record<string, Data>).map(([key, work]) => ({ key, creationId: work.creationId,
        stages: Object.fromEntries(Object.entries(work.stages as Record<string, Data>).map(([name, stage]) => [name,
          { kind: stage.kind, status: stage.status, taskId: stage.taskId, actual: stage.actual, actualUnknown: stage.actualUnknown, reserved: stage.reserved, unlimited: stage.unlimited }])) }));
      const result = { observedAt: new Date().toISOString(), accountingUnit: "tripo_credits", requests };
      await write(join(evidence, `paid-${stamp()}.json`), result); console.log(JSON.stringify(result));
    } else if (command === "artifact-proof") {
      const projection = await json(url, undefined, auth.token);
      const get = async (suffix: string) => {
        const response = await fetch(url + suffix, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Artifact route returned ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      };
      const bytes = await get("/artifact"), manifest = JSON.parse(Buffer.from(bytes).toString("utf8")) as Data;
      if (projection.deliveryStatus !== "pending_delivery" || hash(bytes) !== projection.artifactId ||
          manifest.candidate_hash !== projection.candidateHash || manifest.kind !== projection.kind) throw new Error("Manifest/projection mismatch");
      const refs = new Map<string, number>();
      const visit = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== "object") return;
        const item = value as Data;
        if (typeof item.blob_id === "string") {
          if (!/^[a-f0-9]{64}$/u.test(item.blob_id) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 ||
              (refs.has(item.blob_id) && refs.get(item.blob_id) !== item.bytes)) throw new Error("Invalid blob reference");
          refs.set(item.blob_id, item.bytes);
        }
        Object.values(item).forEach(visit);
      };
      visit(manifest); const blobs: Data[] = [];
      for (const [id, size] of refs) { const blob = await get("/artifact/blobs/" + id);
        if (blob.length !== size || hash(blob) !== id) throw new Error("Blob hash/length mismatch");
        blobs.push({ blobId: id, bytes: size, verified: true });
      }
      const absent = "0".repeat(64); if (refs.has(absent)) throw new Error("Rejection fixture is unexpectedly referenced");
      const rejected = await fetch(url + "/artifact/blobs/" + absent, { headers: { Authorization: `Bearer ${auth.token}` } });
      const error = await rejected.json() as Data;
      if (rejected.status !== 409 || error.error !== "artifact_unavailable") throw new Error("Unreferenced blob rejection mismatch");
      const proof = { requestId: request.requestId, runId: projection.runId, artifactId: hash(bytes), candidateHash: manifest.candidate_hash,
        kind: manifest.kind, manifestBytes: bytes.length, blobs, unreferencedBlobRejected: true, verifiedAt: new Date().toISOString() };
      await writeFile(join(evidence, `artifact-${proof.artifactId}.json`), bytes);
      await write(join(evidence, `artifact-proof-${request.requestId}.json`), proof); console.log(JSON.stringify(proof));
    } else throw new Error("Unknown command; use help");
  }
}

}
await main();
