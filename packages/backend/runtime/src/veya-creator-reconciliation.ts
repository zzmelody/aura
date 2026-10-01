import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import type { PropRecovery } from "./veya-creator-recovery.ts";

type Item = Record<string, any>; // Internal JSON is validated below before admission.
type Source = { role: "raw" | "visual" | "collision"; assetId: string; contentHash: string; resourcePath: string; bytes: Uint8Array };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const hex = /^[a-f0-9]{64}$/u, uuid = /^[a-f0-9-]{36}$/u;
const object = (v: unknown): Item => v && typeof v === "object" && !Array.isArray(v) ? v as Item : {};
const fail = (): never => { throw new Error("preparation_reconciliation_invalid"); };
const directory = (root: string) => join(root, ".aura", "veya-creator", "reconciliation");
const resource = (v: unknown) => typeof v === "string" && /^res:\/\/assets\/generated\/[A-Za-z0-9_./-]+\.(scn|res)$/u.test(v) &&
  !v.slice(6).split("/").some(part => !part || part === "." || part === "..");
const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
const keys = (v: Item, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));

/** This file is an explicit host reconciliation, not a client or model grant.
 * Importing it requires the actual native geometry report and exact registered
 * resource bytes. It authorizes only preparation repair, never new paid work. */
function validate(proof: Item, recovery: PropRecovery, runs: FlowRun[], reportBytes: Uint8Array, sources: Source[]): JsonValue[] {
  const spec = object(recovery.propSpec), receipt = object(recovery.preparation), module = object(object(recovery.retainedProp).module);
  if (!keys(proof, ["schemaVersion", "kind", "sourceRequestId", "sourceRunId", "candidateHash", "moduleHash", "receiptHash", "requirementId", "reportHash", "resources"]) ||
      proof.schemaVersion !== 1 || proof.kind !== "prop_preparation_geometry" || !uuid.test(recovery.sourceRequestId) ||
      proof.sourceRequestId !== recovery.sourceRequestId || proof.sourceRunId !== recovery.sourceRunId ||
      proof.moduleHash !== module.module_id || proof.moduleHash !== module.content_hash || !hex.test(proof.moduleHash) ||
      proof.receiptHash !== receipt.receiptHash || !hex.test(proof.receiptHash) || !hex.test(proof.candidateHash) ||
      proof.reportHash !== hash(reportBytes) || reportBytes.length > 1024 * 1024 || recovery.repairRound >= 3 || !recovery.noNewPaidWork) fail();
  if (!runs.some(run => run.flow.id === "veya/veya-world-build" && run.status === "completed" &&
      object(run.output).status === "ready" && object(object(run.output).candidate).contentHash === proof.candidateHash &&
      Array.isArray(object(run.input).contributions) && object(run.input).contributions.some((entry: unknown) => {
        const value = object(object(entry).module); return value.module_id === proof.moduleHash && value.content_hash === proof.moduleHash;
      }))) fail();
  if (!runs.some(run => run.flow.id === "veya/veya-world-verify" && run.status === "completed" &&
      object(run.output).contentHash === proof.candidateHash && object(run.output).visual === "failed" &&
      Array.isArray(object(run.output).defects) && object(run.output).defects.some((entry: unknown) => {
        const value = object(entry); return value.severity === "error" && ["assets", "prop"].includes(value.owner) &&
          value.requirementId === proof.requirementId && value.moduleId === spec.id;
      }))) fail();
  const raw = (Array.isArray(receipt.sourceBindings) ? receipt.sourceBindings : []).find((b: Item) => b.requirementId === proof.requirementId);
  const prepared = (Array.isArray(receipt.preparedBindings) ? receipt.preparedBindings : []).find((b: Item) => b.requirementId === proof.requirementId);
  if (!raw || !prepared || !Array.isArray(proof.resources) || proof.resources.length !== 3 || sources.length !== 3) fail();
  const expected = { raw: [raw.assetId, raw.version], visual: [prepared.assetId, prepared.version], collision: [prepared.collisionAssetId, prepared.collisionVersion] };
  for (const role of ["raw", "visual", "collision"] as const) {
    const refs = proof.resources.filter((r: Item) => r.role === role), bytes = sources.filter(r => r.role === role);
    if (refs.length !== 1 || bytes.length !== 1) fail();
    const ref = refs[0], source = bytes[0]!;
    if (!keys(ref, ["role", "assetId", "contentHash", "resourcePath", "bytes"]) || ref.assetId !== expected[role][0] ||
        ref.contentHash !== expected[role][1] || !hex.test(ref.contentHash) || !resource(ref.resourcePath) ||
        source.assetId !== ref.assetId || source.resourcePath !== ref.resourcePath || source.contentHash !== ref.contentHash ||
        hash(source.bytes) !== ref.contentHash || source.bytes.length !== ref.bytes || ref.bytes <= 0 || ref.bytes > 128 * 1024 * 1024) fail();
  }
  const report = object(JSON.parse(Buffer.from(reportBytes).toString("utf8"))), original = object(report.raw), normalized = object(report.prepared);
  if (report.kind !== "serialized_resource_geometry" || report.rendered !== false ||
      original.path !== sources.find(s => s.role === "raw")!.resourcePath || normalized.path !== sources.find(s => s.role === "visual")!.resourcePath ||
      !vector(original.min) || !vector(original.size) || !vector(normalized.min) || !vector(normalized.size) ||
      original.size.some(n => n <= 0) || normalized.size.some(n => n <= 0) || !vector(spec.dimensions) ||
      !normalized.size.some((n, index) => n < spec.dimensions[index] * 0.25)) fail();
  return [{ id: "preparation-" + hash(proof.requirementId).slice(0, 20), code: "prop_preparation_geometry", owner: "prop", severity: "error", moduleId: spec.id,
    requirementId: proof.requirementId, description: "Host-verified prepared geometry does not match the locked dimensions; reuse the original source and repair preparation without paid generation." }];
}

/** Called only by the explicit backend acceptance/operations CLI. No HTTP route. */
export async function importPreparationReconciliation(root: string, recovery: PropRecovery, runs: FlowRun[], candidateHash: string,
  requirementId: string, reportBytes: Uint8Array, sources: Source[]): Promise<void> {
  const proof = { schemaVersion: 1, kind: "prop_preparation_geometry", sourceRequestId: recovery.sourceRequestId,
    sourceRunId: recovery.sourceRunId, candidateHash, moduleHash: object(object(recovery.retainedProp).module).module_id,
    receiptHash: object(recovery.preparation).receiptHash, requirementId, reportHash: hash(reportBytes),
    resources: sources.map(({ bytes, ...source }) => ({ ...source, bytes: bytes.length })) };
  validate(proof, recovery, runs, reportBytes, sources);
  const folder = directory(root); await mkdir(join(folder, "blobs"), { recursive: true });
  const immutable = async (path: string, bytes: Uint8Array) => {
    try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await readFile(path)) !== hash(bytes)) throw error; }
  };
  for (const bytes of [reportBytes, ...sources.map(source => source.bytes)]) await immutable(join(folder, "blobs", hash(bytes) + ".bin"), bytes);
  await immutable(join(folder, recovery.sourceRequestId + ".json"), Buffer.from(JSON.stringify(proof)));
}

export async function preparationReconciliation(root: string, recovery: PropRecovery, runs: FlowRun[]): Promise<JsonValue[] | undefined> {
  if (!uuid.test(recovery.sourceRequestId)) fail();
  let bytes: Buffer;
  try { bytes = await readFile(join(directory(root), recovery.sourceRequestId + ".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (bytes.length > 16384) fail();
  const proof = object(JSON.parse(bytes.toString("utf8")));
  if (!hex.test(proof.reportHash) || !Array.isArray(proof.resources) || proof.resources.length !== 3) fail();
  const blob = async (id: string) => { if (!hex.test(id)) fail(); return readFile(join(directory(root), "blobs", id + ".bin")); };
  const sources: Source[] = [];
  for (const entry of proof.resources) sources.push({ ...entry, bytes: await blob(entry.contentHash) });
  return validate(proof, recovery, runs, await blob(proof.reportHash), sources);
}
