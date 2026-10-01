import { createHash } from "node:crypto";

/** Small host-owned grant for immutable, common static Cooker products. */
export type AssetReuseItem = {
  requirement: { id: string; kind: "procedural"; description: string; requiredActions: [] };
  binding: { requirementId: string; assetId: string; version: string; collisionAssetId: string; collisionVersion: string;
    navigationAssetId: string; navigationVersion: string; source: "procedural" };
  producer: { runId: string; operationId: string; sourceHash: string };
};
export type AssetReuseGrant = { schemaVersion: 1; sourceRequestId: string; sourceRunId: string; items: AssetReuseItem[] };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const id = (value: unknown, max = 160) => typeof value === "string" && value.length <= max && /^[A-Za-z0-9_.:-]+$/u.test(value);
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const result = object(value);
  if (!result || Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))
    throw new Error("asset_reuse_unavailable");
  return result;
}
export function readAssetReuseGrant(value: unknown): AssetReuseGrant {
  const grant = exact(value, ["schemaVersion", "sourceRequestId", "sourceRunId", "items"]);
  if (grant.schemaVersion !== 1 || !uuid(grant.sourceRequestId) || !uuid(grant.sourceRunId) ||
      !Array.isArray(grant.items) || !grant.items.length || grant.items.length > 16 || Buffer.byteLength(JSON.stringify(grant)) > 48 * 1024)
    throw new Error("asset_reuse_unavailable");
  const seen = new Set();
  for (const item of grant.items) {
    const i = exact(item, ["requirement", "binding", "producer"]);
    const r = exact(i.requirement, ["id", "kind", "description", "requiredActions"]);
    const b = exact(i.binding, ["requirementId", "assetId", "version", "collisionAssetId", "collisionVersion", "navigationAssetId", "navigationVersion", "source"]);
    const p = exact(i.producer, ["runId", "operationId", "sourceHash"]);
    if (!id(r.id, 96) || r.kind !== "procedural" || typeof r.description !== "string" || !r.description.length || r.description.length > 2000 ||
        !Array.isArray(r.requiredActions) || r.requiredActions.length || seen.has(r.id) || b.requirementId !== r.id || b.source !== "procedural" ||
        ![b.assetId, b.collisionAssetId, b.navigationAssetId].every(value => id(value)) ||
        new Set([b.assetId, b.collisionAssetId, b.navigationAssetId]).size !== 3 ||
        ![b.version, b.collisionVersion, b.navigationVersion].every(sha) || !uuid(p.runId) || !sha(p.sourceHash) ||
        typeof p.operationId !== "string" || !/^cook_[a-f0-9]{32}$/u.test(p.operationId)) throw new Error("asset_reuse_unavailable");
    seen.add(r.id);
  }
  return structuredClone(grant) as AssetReuseGrant;
}

/** Two fixed read-only stages: first syntax continuation, then its one spent
 * retained review. The HTTP request supplies only one previousRequestId. */
export function validateInheritedAssetReuseBinding(value: unknown, previous: unknown, first?: unknown): void {
  const record = object(value), source = object(previous), input = object(record?.input), priorInput = object(source?.input);
  const recovery = object(record?.worldDesignRecovery);
  if (!record || !source || !input || !priorInput || !recovery || input.operation !== "create_world" ||
      !uuid(input.previousRequestId) || input.reuseAssetsFromRequestId !== undefined || input.previousArtifactId !== undefined ||
      recovery.sourceRequestId !== input.previousRequestId || recovery.sourceRunId !== source.runId ||
      recovery.schemaVersion !== 1 || record.recovery || record.previousArtifact ||
      source.recovery || source.previousArtifact || priorInput.operation !== "create_world" || priorInput.previousArtifactId !== undefined ||
      !["playerId", "homeWorldId", "creationSessionId", "sessionPath"].every(key =>
        typeof record[key] === "string" && record[key] === source[key]) ||
      typeof input.text !== "string" || input.text !== priorInput.text) throw new Error("asset_reuse_unavailable");
  const grant = readAssetReuseGrant(record.assetReuse), original = readAssetReuseGrant(source.assetReuse);
  if (JSON.stringify(grant) !== JSON.stringify(original))
    throw new Error("asset_reuse_unavailable");
  if (!source.worldDesignRecovery) {
    if (recovery.formatCorrectionUsed !== false || recovery.retainedSpec !== undefined || recovery.specHash !== undefined ||
        recovery.semanticRevisionUsed !== undefined || recovery.reviewRetryUsed !== undefined || source.recoveryBudgetCreationId ||
        record.recoveryBudgetCreationId !== input.previousRequestId || priorInput.previousRequestId !== undefined ||
        priorInput.reuseAssetsFromRequestId !== grant.sourceRequestId) throw new Error("asset_reuse_unavailable");
    return;
  }
  // Recursion is deliberately one level: the first-stage check rejects a prior
  // review, missing original binding, or a cyclic chain before any native call.
  const sourceRecovery = object(source.worldDesignRecovery), originalBinding = object(first);
  if (!sourceRecovery || sourceRecovery.formatCorrectionUsed !== false || sourceRecovery.retainedSpec !== undefined ||
      sourceRecovery.semanticRevisionUsed !== undefined || sourceRecovery.reviewRetryUsed !== undefined ||
      !originalBinding || originalBinding.worldDesignRecovery || priorInput.reuseAssetsFromRequestId !== undefined ||
      recovery.formatCorrectionUsed !== true || recovery.semanticRevisionUsed !== true || recovery.reviewRetryUsed !== true ||
      !object(recovery.retainedSpec) || !sha(recovery.specHash) ||
      createHash("sha256").update(JSON.stringify(recovery.retainedSpec), "utf8").digest("hex") !== recovery.specHash ||
      record.recoveryBudgetCreationId !== source.recoveryBudgetCreationId) throw new Error("asset_reuse_unavailable");
  validateInheritedAssetReuseBinding(source, first);
  for (const key of ["brief", "plan", "designInput", "draftText", "draftHash"])
    if (JSON.stringify(recovery[key]) !== JSON.stringify(sourceRecovery[key])) throw new Error("asset_reuse_unavailable");
}

/** Called again against the bound live worker before returning creator context. */
export function verifyAssetReuseCatalog(grant: AssetReuseGrant, value: unknown): void {
  const catalog = object(value);
  if (!catalog) throw new Error("asset_reuse_catalog_mismatch");
  for (const { binding: b, producer: p } of grant.items) {
    const base = `proc_${p.sourceHash.slice(0, 40)}_`;
    for (const [assetId, version, role, type] of [
      [b.assetId, b.version, "visual", "model"], [b.collisionAssetId, b.collisionVersion, "collision", "model"],
      [b.navigationAssetId, b.navigationVersion, "navigation", "navigation"],
    ]) {
      const asset = object(catalog[assetId!]);
      if (!asset || asset.id !== assetId || asset.content_hash !== version || asset.type !== type ||
          asset.source_asset_id !== base + role || asset.local_generated !== true) throw new Error("asset_reuse_catalog_mismatch");
    }
  }
}
