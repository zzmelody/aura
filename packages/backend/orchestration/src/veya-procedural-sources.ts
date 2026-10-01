import { createHash } from "node:crypto";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { materialIdentity } from "./veya-creator-materials.ts";

export type ProceduralSourceRef = { schemaVersion: 1; requirementId: string; producerRunId: string;
  operationId: string; sourceHash: string; bindingHash: string };
type Binding = { requirementId: string; assetId: string; version: string; collisionAssetId: string; collisionVersion: string;
  navigationAssetId: string; navigationVersion: string; source: "procedural" };
export type ProceduralSource = { ref: ProceduralSourceRef; binding: Binding;
  meshRecipe: { source: string; sha256: string }; sceneRecipe: { source: string; sha256: string } };
export type ProceduralRoot = { run: FlowRun; pins?: ReadonlyMap<string, string> };
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hash = /^[a-f0-9]{64}$/u;
const reads = new Set(["veya/cooker-capabilities", "veya/asset-list"]);
const keys = ["schemaVersion", "requirementId", "producerRunId", "operationId", "sourceHash", "bindingHash"];
function reject(): never { throw new Error("creator_procedural_sources_unavailable"); }

export function readProceduralRefs(value: unknown): ProceduralSourceRef[] {
  if (!Array.isArray(value) || value.length > 64) reject();
  const seen = new Set<string>();
  for (const ref of value) {
    const o = object(ref);
    if (!o || Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k)) || o.schemaVersion !== 1 ||
        typeof o.requirementId !== "string" || !/^[A-Za-z0-9_.:-]{1,96}$/u.test(o.requirementId) ||
        typeof o.producerRunId !== "string" || !/^[a-f0-9-]{36}$/u.test(o.producerRunId) ||
        typeof o.operationId !== "string" || !/^cook_[a-f0-9]{32}$/u.test(o.operationId) ||
        typeof o.sourceHash !== "string" || !hash.test(o.sourceHash) || typeof o.bindingHash !== "string" || !hash.test(o.bindingHash) ||
        seen.has(o.producerRunId)) reject();
    seen.add(o.producerRunId);
  }
  return value as ProceduralSourceRef[];
}

function proveProducer(run: FlowRun): ProceduralSource | undefined {
  const input = object(run.input), output = object(run.output);
  // A catalog hit without a durable successful Cooker receipt cannot manufacture
  // provenance. Its original admitted producer may still be found in ancestors.
  if (run.status !== "completed" || output?.status !== "ready" || !output.operationId) return undefined;
  if (!input || output.schemaVersion !== 1 || !hash.test(output.sourceHash) || !Array.isArray(run.steps)) reject();
  for (const step of run.steps) {
    if (step.status !== "completed") reject();
    if (step.kind === "agent") {
      if (!Array.isArray(step.actions) || step.actions.some(a => !reads.has(a.id) || !hash.test(a.sourceHash))) reject();
    } else if (step.kind !== "action" || ![...reads, "veya/cooker-submit", "veya/cooker-status"].includes(step.actionId)) reject();
  }
  const submits = run.steps.filter(s => s.kind === "action" && s.actionId === "veya/cooker-submit");
  const waits = run.steps.filter(s => s.kind === "action" && s.actionId === "veya/cooker-status");
  const receipts = new Map<string, Record<string, any>>();
  const terminal = ["succeeded", "failed", "cancelled"];
  for (const submitted of submits) {
    const receipt = object(submitted.output), operation = receipt?.operation_id;
    if (!receipt || typeof operation !== "string" || !/^cook_[a-f0-9]{32}$/u.test(operation) || receipts.has(operation)) reject();
    const matching = waits.filter(s => s.kind === "action" && object(s.input)?.operationId === operation);
    if (terminal.includes(receipt.status)) {
      // The Flow skips its wait step when submit itself returned a terminal
      // receipt. A second receipt is not an alternative provenance source.
      if (matching.length) reject();
      receipts.set(operation, receipt);
    } else {
      if (!["queued", "running"].includes(receipt.status) || matching.length !== 1) reject();
      const completed = object(matching[0]!.output);
      if (!completed || completed.operation_id !== operation || !terminal.includes(completed.status)) reject();
      receipts.set(operation, completed);
    }
  }
  if (waits.some(s => s.kind !== "action" || !receipts.has(object(s.input)?.operationId))) reject();
  const matches = submits.filter(s => object(s.output)?.operation_id === output.operationId);
  if (matches.length !== 1) reject();
  const submit = matches[0]!, completed = receipts.get(output.operationId);
  if (submit.kind !== "action") reject();
  const sources = object(submit.input)?.sources;
  if (!completed || completed.status !== "succeeded" || completed.cooker?.ok !== true || !Array.isArray(completed.cooker.steps) ||
      completed.cooker.steps.length !== 10 || completed.cooker.steps.some((s: any) => s.ok !== true || s.error !== 0) ||
      !Array.isArray(completed.assets) || !Array.isArray(sources) || sources.length !== 2) reject();
  const mesh = sources.find((s: any) => s.path === "content/scripts/cooker/agent_generated/mesh.luau")?.source;
  const scene = sources.find((s: any) => s.path === "content/scripts/cooker/agent_generated/scene.luau")?.source;
  if (typeof mesh !== "string" || typeof scene !== "string" || [mesh, scene].some(s => !s.length || Buffer.byteLength(s) > 64000) ||
      sha(JSON.stringify([sha(JSON.stringify([input.requirementId, input.description, input.revisionHint ?? "", "procedural-v1"])), mesh, scene])) !== output.sourceHash) reject();
  const binding: Binding = { requirementId: input.requirementId, assetId: output.visual?.assetId, version: output.visual?.version,
    collisionAssetId: output.collision?.assetId, collisionVersion: output.collision?.version,
    navigationAssetId: output.navigation?.assetId, navigationVersion: output.navigation?.version, source: "procedural" };
  const ref: ProceduralSourceRef = { schemaVersion: 1, requirementId: input.requirementId, producerRunId: run.id,
    operationId: output.operationId, sourceHash: output.sourceHash, bindingHash: materialIdentity(binding) };
  readProceduralRefs([ref]);
  const result = { ref, binding, meshRecipe: { source: mesh, sha256: sha(mesh) }, sceneRecipe: { source: scene, sha256: sha(scene) } };
  verifyProceduralCatalog([result], Object.fromEntries(completed.assets.map((a: any) => [a.id, a])));
  return result;
}

/** Only roots authorized by the binding owner enter this walker; a query never
 * supplies a root/path. Every producer must be linked by actual durable edges. */
export function collectProceduralSources(roots: ProceduralRoot[], get: (id: string) => FlowRun): ProceduralSource[] {
  const result = new Map<string, ProceduralSource>();
  for (const { run: root, pins } of roots) {
    const seen = new Set<string>();
    const visit = (run: FlowRun, depth: number): void => {
      if (depth > 8 || seen.size >= 256 || seen.has(run.id)) reject();
      seen.add(run.id);
      if (run.flow.id === "veya/veya-procedural-asset") {
        const proven = proveProducer(run);
        if (proven && (!pins || bindingPins(proven.binding).every(([id, hash]) => pins.get(id) === hash))) result.set(run.id, proven);
      }
      for (const step of run.steps ?? []) if (step.kind === "flow" && step.childRunId) {
        const child = get(step.childRunId);
        if (!child || child.id !== step.childRunId || child.parent?.runId !== run.id || child.parent.stepKey !== step.stepKey) reject();
        if (child.flow.id === "veya/veya-procedural-asset" && step.status !== "completed") continue;
        visit(child, depth + 1);
      }
    };
    visit(root, 0);
  }
  if (result.size > 64) reject();
  return [...result.values()];
}

function bindingPins(b: Binding): [string, string][] {
  return [[b.assetId, b.version], [b.collisionAssetId, b.collisionVersion], [b.navigationAssetId, b.navigationVersion]];
}
export function verifyProceduralCatalog(sources: ProceduralSource[], value: unknown): void {
  const catalog = object(value); if (!catalog) reject();
  for (const { ref, binding } of sources) {
    const pins = bindingPins(binding);
    if (new Set(pins.map(([id]) => id)).size !== 3) reject();
    for (const [i, [id, version]] of pins.entries()) {
      const asset = object(catalog[id]);
      if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/u.test(id) || typeof version !== "string" || !hash.test(version) || !asset || asset.id !== id || asset.content_hash !== version ||
          asset.local_generated !== true || asset.type !== (i === 2 ? "navigation" : "model") ||
          asset.source_asset_id !== `proc_${ref.sourceHash.slice(0, 40)}_${["visual", "collision", "navigation"][i]}`) reject();
    }
  }
}
export function projectProceduralSources(sources: ProceduralSource[], requested: ProceduralSourceRef[]): JsonValue {
  const result = requested.length ? { schemaVersion: 1, proceduralSources: requested.map(ref => {
    const found = sources.find(s => materialIdentity(s.ref) === materialIdentity(ref));
    if (!found) reject(); return found;
  }) } : { schemaVersion: 1, proceduralRefs: sources.map(s => s.ref) };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error("creator_context_capacity_exceeded");
  return result as unknown as JsonValue;
}
