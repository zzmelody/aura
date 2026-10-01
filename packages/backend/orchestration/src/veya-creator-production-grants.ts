import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@aura/protocol/types";
import { environmentShaderPins, matchesEnvironmentShader } from "./veya-atmosphere-provenance.ts";

export type WorldProductionRecovery = { schemaVersion: 1; sourceRequestId: string; sourceRunId: string;
  brief: JsonValue; continuation: []; resume: JsonValue; resumeHash: string; noNewPaidWork: true; nextRound: number };
export type ProductionGrantRef = { grantId: string; contentHash: string };
export type ProductionGrant = { version: 1;
  identity: { playerId: string; homeWorldId: string; creationSessionId: string; textHash: string };
  recovery: WorldProductionRecovery;
  proof: { world: { worldId: string; ownerId: string; revision: number; contentHash: string };
    draft: JsonValue;
    assets: { assetId: string; contentHash: string }[];
    modules: { moduleId: string; contentHash: string }[];
    pendingRound?: { schemaVersion: 1; round: 3; worldRunId: string; completedBuildRunId: string;
      blockedBuildRunId: string; environmentRunId: string; finalResumeHash: string;
      completedOutputHash: string; blockedInputHash: string; resolvedSpecHash: string };
    completedOperations: { operation?: "veya.cooker.submit" | "veya.atmosphere.build"; operationId: string; fingerprint: string }[] } };
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const sha = /^[a-f0-9]{64}$/u;
export const productionDigest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");
export const productionRecoveryBoundary = (grant: ProductionGrant): string => {
  const r = grant.recovery;
  return productionDigest([r.sourceRequestId, r.sourceRunId, r.resumeHash, r.nextRound]);
};
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(object(v)!).sort().map(k => [k, canonical(object(v)![k])])) : v;
export const cookerSubmissionFingerprint = (v: unknown): string => {
  const input = object(v); if (!input || typeof (input.pipelineSource ?? input.pipeline_source) !== "string") throw new Error("production_grant_invalid");
  return productionDigest(canonical([input.pipelineSource ?? input.pipeline_source, input.sources ?? [], input.inputs ?? []]));
};
export function validateProductionGrant(value: unknown): ProductionGrant {
  const v = object(value), r = object(v?.recovery), resume = object(r?.resume), identity = object(v?.identity), proof = object(v?.proof), world = object(proof?.world);
  if (!v || v.version !== 1 || !r || r.schemaVersion !== 1 || !resume || !identity || !proof || !world ||
      !/^[a-f0-9-]{36}$/u.test(r.sourceRequestId) || !/^[a-f0-9-]{36}$/u.test(r.sourceRunId) ||
      r.noNewPaidWork !== true || !Array.isArray(r.continuation) || r.continuation.length ||
      !Number.isInteger(resume.round) || resume.round < 0 || resume.round >= 3 || r.nextRound !== resume.round + 1 ||
      !sha.test(r.resumeHash) || productionDigest(resume) !== r.resumeHash ||
      object(r.brief)?.operation !== "create_world" || !sha.test(identity.textHash) ||
      !/^[a-f0-9]{32}$/u.test(identity.creationSessionId) ||
      [identity.playerId, identity.homeWorldId].some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(id)) ||
      world.worldId !== resume.worldId || !/^[a-f0-9]{32}$/u.test(world.worldId) || !/^[a-f0-9]{32}$/u.test(world.ownerId) ||
      !object(proof.draft) || proof.draft.draft_id !== resume.draft?.draft_id || proof.draft.world_id !== world.worldId ||
      proof.draft.base_revision !== resume.draft?.base_revision || !Number.isInteger(proof.draft.draft_revision) ||
      proof.draft.draft_revision < resume.draft?.draft_revision || !sha.test(proof.draft.content_hash) ||
      !Number.isInteger(world.revision) || world.revision < 1 || !sha.test(world.contentHash) ||
      !Array.isArray(proof.assets) || proof.assets.length > 256 || proof.assets.some((a: any) =>
        typeof a.assetId !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/u.test(a.assetId) || !sha.test(a.contentHash)) ||
      new Set(proof.assets.map((a: any) => a.assetId)).size !== proof.assets.length ||
      !Array.isArray(proof.modules) || proof.modules.length > 32 || proof.modules.some((m: any) => !sha.test(m.moduleId) || !sha.test(m.contentHash)) ||
      !Array.isArray(proof.completedOperations) || proof.completedOperations.length > 128 ||
      proof.completedOperations.some((op: any) => (op.operation !== undefined && !["veya.cooker.submit", "veya.atmosphere.build"].includes(op.operation)) ||
        typeof op.operationId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(op.operationId) || !sha.test(op.fingerprint)) ||
      Buffer.byteLength(JSON.stringify(r)) > 240 * 1024 || Buffer.byteLength(JSON.stringify(v)) > 256 * 1024)
    throw new Error("production_grant_invalid");
  if (proof.pendingRound !== undefined) {
    const p = object(proof.pendingRound), fields = ["schemaVersion", "round", "worldRunId", "completedBuildRunId", "blockedBuildRunId",
      "environmentRunId", "finalResumeHash", "completedOutputHash", "blockedInputHash", "resolvedSpecHash"];
    if (!p || Object.keys(p).length !== fields.length || fields.some(k => !Object.hasOwn(p, k)) ||
        p.schemaVersion !== 1 || p.round !== 3 || resume.round !== 2 || r.nextRound !== 3 ||
        ["worldRunId", "completedBuildRunId", "blockedBuildRunId", "environmentRunId"].some(k => !/^[a-f0-9-]{36}$/iu.test(p[k])) ||
        new Set([p.worldRunId, p.completedBuildRunId, p.blockedBuildRunId, p.environmentRunId, r.sourceRunId]).size !== 5 ||
        ["finalResumeHash", "completedOutputHash", "blockedInputHash", "resolvedSpecHash"].some(k => !sha.test(p[k])) ||
        p.completedOutputHash !== productionDigest(resume.build) || p.resolvedSpecHash !== productionDigest(resume.build?.gameplaySpec))
      throw new Error("production_grant_invalid");
  }
  return value as ProductionGrant;
}

/** A committed binding reserves the one successor, even when start's response
 * was lost. The same request can retry; another request cannot borrow the round.
 * This scans existing immutable refs and adds no separate scheduler or ledger. */
export async function validatePendingProductionClaims(root: string, bindings: Record<string, any>): Promise<void> {
  const grants = new Map<string, ProductionGrant>();
  for (const [requestId, binding] of Object.entries(bindings)) {
    const marked = Object.hasOwn(binding, "productionRecoveryClaimVersion") || Object.hasOwn(binding, "productionRecoveryClaim");
    if (marked && (!binding.worldProductionRecoveryRef || binding.productionRecoveryClaimVersion !== 1 ||
        typeof binding.productionRecoveryClaim !== "string" || !sha.test(binding.productionRecoveryClaim)))
      throw new Error("production_recovery_claim_invalid");
    if (binding.worldProductionRecoveryRef) grants.set(requestId, await readProductionGrant(root, binding.worldProductionRecoveryRef));
  }
  for (const [requestId, grant] of grants) {
    const binding = bindings[requestId];
    if (binding.productionRecoveryClaimVersion === 1) {
      if (grant.proof.pendingRound || binding.productionRecoveryClaim !== productionRecoveryBoundary(grant))
        throw new Error("production_recovery_claim_invalid");
      validateProductionBinding(grant, binding, bindings[grant.recovery.sourceRequestId]);
      // Historical unmarked bindings remain readable but still occupy their
      // boundary. New writers cannot reopen one of those old attempts.
      if ([...grants].some(([otherId, other]) => otherId !== requestId &&
          productionRecoveryBoundary(other) === binding.productionRecoveryClaim))
        throw new Error("production_round_already_claimed");
    }
    if (!grant.proof.pendingRound) continue;
    const sourceId = grant.recovery.sourceRequestId;
    validateProductionBinding(grant, bindings[requestId], bindings[sourceId]);
    const successors = Object.entries(bindings).filter(([, b]) => b.input?.previousRequestId === sourceId);
    if (successors.length !== 1 || successors[0]![0] !== requestId)
      throw new Error("production_round_already_claimed");
  }
}
/** Host-only immutable metadata. No caller path or source JSON is accepted. */
export async function writeProductionGrant(root: string, value: ProductionGrant): Promise<ProductionGrantRef> {
  validateProductionGrant(value);
  const bytes = JSON.stringify(value), hash = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, ".aura", "veya-creator", "grants");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${hash}.json`);
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== bytes) throw error; }
  return { grantId: hash, contentHash: hash };
}
export async function readProductionGrant(root: string, ref: ProductionGrantRef): Promise<ProductionGrant> {
  if (!ref || !sha.test(ref.grantId) || ref.contentHash !== ref.grantId || Object.keys(ref).length !== 2) throw new Error("production_grant_invalid");
  let bytes: Buffer;
  try { bytes = await readFile(join(root, ".aura", "veya-creator", "grants", `${ref.grantId}.json`)); }
  catch { throw new Error("production_grant_invalid"); }
  if (bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== ref.contentHash) throw new Error("production_grant_invalid");
  return validateProductionGrant(JSON.parse(bytes.toString("utf8")));
}
export function validateProductionBinding(grant: ProductionGrant, binding: any, source: any): void {
  const identity = grant.identity, recovery = grant.recovery;
  if (!source || binding.input?.operation !== "create_world" || binding.input.previousRequestId !== recovery.sourceRequestId ||
      source.runId !== recovery.sourceRunId || binding.recovery || binding.worldDesignRecovery || binding.assetReuse || binding.previousArtifact ||
      binding.input.reuseAssetsFromRequestId || binding.input.reuseProductionFromRequestId || binding.productionMaterialsRef ||
      binding.input.previousArtifactId || source.input?.operation !== "create_world" ||
      source.input.text !== binding.input.text || productionDigest(binding.input.text) !== productionDigest(source.input.text) ||
      createHash("sha256").update(binding.input.text).digest("hex") !== identity.textHash ||
      ["playerId", "homeWorldId", "creationSessionId"].some(key => binding[key] !== (identity as any)[key] || source[key] !== binding[key]) ||
      source.sessionPath !== binding.sessionPath || binding.recoveryBudgetCreationId !== (source.recoveryBudgetCreationId ?? recovery.sourceRequestId))
    throw new Error("production_grant_binding_mismatch");
}
/** Reads only. It neither activates the world nor creates a replacement draft. */
export async function verifyProductionWorker(grant: ProductionGrant, call: (operation: string, input: JsonValue) => Promise<JsonValue>, maxRepairRounds: number): Promise<void> {
  validateProductionGrant(grant);
  const { recovery: r, proof } = grant, resume = object(r.resume)!;
  function reject(): never { throw new Error("production_recovery_state_changed"); }
  if (r.nextRound > maxRepairRounds) reject();
  const status = object(await call("veya.world.status", {}));
  if (status?.playtest_id || object(status?.profile)?.player_id !== proof.world.ownerId ||
      object(status?.profile)?.home_world_id !== grant.identity.homeWorldId) reject();
  const world = object(await call("veya.world.read", { world_id: proof.world.worldId })), manifest = object(world?.manifest);
  if (world?.revision !== proof.world.revision || world?.content_hash !== proof.world.contentHash ||
      manifest?.world_id !== proof.world.worldId || manifest.owner_id !== proof.world.ownerId || manifest.revision !== proof.world.revision) reject();
  const draft = object(await call("veya.draft.read", { draft_id: resume.draft?.draft_id }));
  for (const key of ["draft_id", "draft_revision", "world_id", "base_revision", "content_hash", "assets", "asset_versions"])
    if (JSON.stringify(canonical(draft?.[key])) !== JSON.stringify(canonical(object(proof.draft)?.[key]))) reject();
  const catalog = object(await call("veya.assets.list", {}));
  for (const asset of proof.assets) if (object(catalog?.[asset.assetId])?.content_hash !== asset.contentHash) reject();
  for (const p of environmentShaderPins(resume.build)) if (!matchesEnvironmentShader(p, catalog?.[p.assetId])) reject();
  for (const module of proof.modules) {
    const result = object(await call("veya.creation.module.read", { module_id: module.moduleId, content_hash: module.contentHash }));
    if (result?.module_id !== module.moduleId || result.content_hash !== module.contentHash) reject();
    for (const asset of result.assets ?? []) if (!proof.assets.some(a => a.assetId === asset.asset_id && a.contentHash === asset.content_hash)) reject();
  }
}
