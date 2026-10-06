import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { ActionFailure, type AuraCapabilityClient } from "./action-api.ts";
import { VEYA_WORLD_AGENT_CAPABILITY, type VeyaRunSession } from "./veya-world-agent.ts";
import { readCreatorBindingDocument } from "./veya-creator-design-grants.ts";
import { assertCraftToolScope, craftToolScope, readVeyaCraftScope, verifyCraftForeground, type VeyaCraftScope } from "./veya-gameplay-craft.ts";
import { readAssetReuseGrant, verifyAssetReuseCatalog, validateInheritedAssetReuseBinding, type AssetReuseGrant } from "./veya-creator-asset-reuse.ts";
import { readProductionGrant, validateProductionBinding, validatePendingProductionClaims, verifyProductionWorker, productionDigest,
  type ProductionGrantRef, type ProductionGrant } from "./veya-creator-production-grants.ts";
import { readMaterialsGrant, validateMaterialsBinding, verifyMaterialsWorker, materialSubmissionFingerprint, type MaterialsGrant } from "./veya-creator-materials.ts";
import { collectProceduralSources, projectProceduralSources, readProceduralRefs, verifyProceduralCatalog,
  type ProceduralRoot, type ProceduralSource } from "./veya-procedural-sources.ts";

export const VEYA_CREATOR_CAPABILITY = "aura.veya.creator";
export const CREATOR_REQUIRED_TOOLS = Object.freeze([
  "veya.creation.module.write", "veya.creation.module.read", "veya.creation.export", "veya.creation.checkout",
  "veya.draft.compose", "veya.playtest.save_resume", "veya.preview.performance",
  "veya.character.inspect",
]);
export const CREATOR_REQUIRED_VERIFICATION = Object.freeze([
  "progress_projection", "creation_geometry", "stable_interaction_ids", "authored_identities",
]);
type Binding = { sessionPath: string; creationSessionId?: string; runId?: string; homeWorldId?: string; kind?: string;
  craftAuthorization?: VeyaCraftScope; foregroundSessionPath?: string;
  craftOriginalAuthorization?: VeyaCraftScope;
  playerId?: string; worldProductionRecoveryRef?: ProductionGrantRef; productionGrant?: ProductionGrant;
  productionRecoveryClaimVersion?: 1; productionRecoveryClaim?: string;
  productionMaterialsRef?: ProductionGrantRef; materialsGrant?: MaterialsGrant;
  recovery?: JsonValue; worldDesignRecovery?: JsonValue; assetReuse?: AssetReuseGrant; recoveryBudgetCreationId?: string;
  previousArtifact?: { artifactId: string; candidateHash: string; kind: "world" | "prop" | "patch" };
  input?: { operation: string; text?: string; previousRequestId?: string; targetWorldId?: string; target?: { worldId: string; baseRevision: number; baseHash?: string; allowedEntityIds: string[]; allowSpawnChange: boolean }; artifactTarget?: { allowedEntityIds: string[]; allowSpawnChange: boolean }; previousArtifactId?: string; reuseAssetsFromRequestId?: string; reuseProductionFromRequestId?: string; references?: string[] } };

/** Resolve a creation run to the worker registered before that run started. */
export class VeyaCreatorBindings {
  readonly path: string;
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.path = join(projectRoot, ".aura", "veya-creator", "bindings.json");
  }

  async resolve(runId: string, get: (runId: string) => FlowRun, operation?: string, input?: JsonValue): Promise<VeyaRunSession | undefined> {
    const bound = await this.binding(runId, get);
    if (operation?.startsWith("veya.craft.")) {
      if (!bound?.record.craftAuthorization || !bound.record.foregroundSessionPath) throw new ActionFailure("craft_authority_unavailable");
      const original=readVeyaCraftScope(bound.record.craftOriginalAuthorization ?? bound.record.craftAuthorization);
      const current=readVeyaCraftScope(bound.record.craftAuthorization);
      try { assertCraftToolScope(original, input); await verifyCraftForeground(bound.record.foregroundSessionPath); }
      catch { throw new ActionFailure("craft_scope_mismatch"); }
      if(original.instanceId!==current.instanceId||original.runtimeEpoch!==current.runtimeEpoch)
        return { path: bound.record.foregroundSessionPath, input: { ...(input as Record<string, JsonValue>), ...craftToolScope(current) }, outputScope: craftToolScope(original) };
      return bound.record.foregroundSessionPath;
    }
    if (bound?.record.materialsGrant && ["veya.cooker.submit", "veya.atmosphere.build"].includes(operation ?? "")) {
      const completed = bound.record.materialsGrant.proof.completedOperations.find(op => op.operation === operation &&
        op.fingerprint === materialSubmissionFingerprint(operation!, input));
      if (completed) throw new ActionFailure(`creator_completed_operation_reuse_required: ${completed.operationId}`);
    }
    if (bound?.record.productionGrant && ["veya.cooker.submit", "veya.atmosphere.build"].includes(operation ?? "")) {
      const completed = bound.record.productionGrant.proof.completedOperations.find(op =>
        (op.operation ?? "veya.cooker.submit") === operation && op.fingerprint === materialSubmissionFingerprint(operation!, input));
      if (completed) throw new ActionFailure(`creator_completed_operation_reuse_required: ${completed.operationId}`);
    }
    if (operation === "veya.cooker.submit") {
      const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
      const next = object(input);
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
        ? Object.fromEntries(Object.keys(object(value)!).sort().map(key => [key, canonical(object(value)![key])])) : value;
      if (bound && next) {
        if (bound.record.assetReuse && Array.isArray(next.sources)) {
          const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
          const mesh = next.sources.map(object).find(s => s?.path === "content/scripts/cooker/agent_generated/mesh.luau")?.source;
          const scene = next.sources.map(object).find(s => s?.path === "content/scripts/cooker/agent_generated/scene.luau")?.source;
          if (typeof mesh === "string" && typeof scene === "string") for (const item of readAssetReuseGrant(bound.record.assetReuse).items) {
            const r = item.requirement;
            if (digest([digest([r.id, r.description, "", "procedural-v1"]), mesh, scene]) === item.producer.sourceHash)
              throw new ActionFailure(`creator_completed_asset_reuse_required: ${item.producer.operationId}`);
          }
        }
        const bytes = await readFile(this.path);
        if (bytes.length > 256 * 1024) throw new ActionFailure("creator_worker_binding_unavailable");
        const history = await readCreatorBindingDocument(this.projectRoot, bytes) as unknown as { bindings: Record<string, Binding> };
        const budgetId = bound.record.recoveryBudgetCreationId ?? bound.run.requestId;
        for (const [requestId, record] of Object.entries(history.bindings)) {
          if ((record.recoveryBudgetCreationId ?? requestId) !== budgetId || record.creationSessionId !== bound.record.creationSessionId) continue;
          const completed = object(object(record.recovery)?.preparedOperation), prior = object(completed?.submission);
          if (prior && JSON.stringify(canonical([prior.pipelineSource, prior.sources ?? [], prior.inputs ?? []])) ===
              JSON.stringify(canonical([next.pipeline_source, next.sources ?? [], next.inputs ?? []])))
            throw new ActionFailure(`creator_prepared_operation_reuse_required: ${String(completed!.operationId)}`);
        }
      }
    }
    if (operation === "veya.creation.checkout") {
      const ref = bound?.record.previousArtifact;
      const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const overlay = bound?.record.input?.operation.startsWith("update_");
      if (!ref || ref.artifactId !== bound?.record.input?.previousArtifactId || body.artifact_id !== ref.artifactId ||
          body.content_hash !== ref.artifactId || body.mode !== (overlay ? "overlay" : "recompose") ||
          bound?.record.input?.target || (overlay && (!bound?.record.input?.artifactTarget || ref.kind === "prop")))
        throw new ActionFailure("creator_artifact_binding_mismatch");
    }
    if (operation === "veya.world.read") {
      const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      if (body.artifact_id !== undefined || body.artifact_content_hash !== undefined) {
        const ref = bound?.record.previousArtifact, target = bound?.record.input?.target;
        if (!ref || ref.kind === "prop" || ref.artifactId !== bound?.record.input?.previousArtifactId ||
            !/^[a-f0-9]{64}$/u.test(ref.candidateHash) ||
            !bound?.record.input?.operation.startsWith("update_") || !target?.baseHash ||
            body.artifact_id !== ref.artifactId || body.artifact_content_hash !== ref.artifactId || body.world_id !== target.worldId ||
            body.expected_revision !== target.baseRevision || body.expected_content_hash !== target.baseHash)
          throw new ActionFailure("creator_artifact_binding_mismatch");
      }
    }
    return bound?.record.sessionPath;
  }

  async binding(runId: string, get: (runId: string) => FlowRun, verifyWorker = true): Promise<{ run: FlowRun; record: Binding } | undefined> {
    let run = get(runId);
    for (let depth = 0; run.parent; ++depth) {
      if (depth >= 8) throw new ActionFailure("creator_run_ancestry_invalid");
      run = get(run.parent.runId);
    }
    if (!["veya/veya-wish", "veya/veya-gameplay-craft"].includes(run.flow.id)) return undefined;
    let source: unknown;
    try {
      const bytes = await readFile(this.path);
      if (bytes.length > 256 * 1024) throw new Error("size");
      source = await readCreatorBindingDocument(this.projectRoot, bytes);
    } catch {
      throw new ActionFailure("creator_worker_binding_unavailable");
    }
    const document = source as { version?: unknown; bindings?: Record<string, unknown> };
    let record = document?.version === 1 ? document.bindings?.[run.requestId] as Binding | undefined : undefined;
    if (!record || typeof record.sessionPath !== "string" || !isAbsolute(record.sessionPath))
      throw new ActionFailure("creator_worker_binding_unavailable");
    if (run.flow.id === "veya/veya-gameplay-craft") {
      try { const grant = readVeyaCraftScope(record.craftOriginalAuthorization ?? record.craftAuthorization); const actual = readVeyaCraftScope(run.input);
        if (Object.entries(grant).some(([key, value]) => actual[key as keyof typeof actual] !== value) || !record.foregroundSessionPath) throw new Error("scope"); }
      catch { throw new ActionFailure("craft_authority_unavailable"); }
    } else if (record.craftAuthorization) throw new ActionFailure("craft_authority_unavailable");
    if (record.assetReuse && record.worldDesignRecovery) {
      try { const previous = document.bindings?.[record.input?.previousRequestId ?? ""] as Binding | undefined;
        validateInheritedAssetReuseBinding(record, previous, document.bindings?.[previous?.input?.previousRequestId ?? ""]); }
      catch { throw new ActionFailure("asset_reuse_unavailable"); }
    }
    if (record.worldProductionRecoveryRef) {
      try {
        const productionGrant = await readProductionGrant(this.projectRoot, record.worldProductionRecoveryRef);
        validateProductionBinding(productionGrant, record, document.bindings?.[record.input?.previousRequestId ?? ""]);
        if (record.productionRecoveryClaimVersion !== undefined || record.productionRecoveryClaim !== undefined)
          await validatePendingProductionClaims(this.projectRoot, document.bindings!);
        record = { ...record, productionGrant };
      } catch { throw new ActionFailure("creator_production_recovery_unavailable"); }
    }
    if (record.productionMaterialsRef) {
      try {
        const materialsGrant = await readMaterialsGrant(this.projectRoot, record.productionMaterialsRef);
        validateMaterialsBinding(materialsGrant, record, document.bindings?.[record.input?.reuseProductionFromRequestId ?? ""]);
        record = { ...record, materialsGrant };
      } catch { throw new ActionFailure("creator_production_materials_unavailable"); }
    }
    // The first Action may start before the creator route records the Run ID.
    // Once recorded, another Run with the same request ID cannot borrow it.
    if (record.runId !== undefined && record.runId !== run.id)
      throw new ActionFailure("creator_worker_binding_mismatch");
    if (!record.creationSessionId || !/^[a-f0-9]{32}$/u.test(record.creationSessionId))
      throw new ActionFailure("creator_worker_identity_unavailable");
    // Cancellation must still stop the durable Run when its worker is offline.
    // This internal read grants no native access; actual calls validate again.
    if (!verifyWorker) return { run, record };
    let worker;
    try {
      const bytes = await readFile(record.sessionPath);
      if (bytes.length > 8192) throw new Error("size");
      worker = JSON.parse(bytes.toString("utf8"));
    } catch { throw new ActionFailure("creator_worker_binding_unavailable"); }
    if (worker.role !== "creator-worker" || worker.creation_session_id !== record.creationSessionId)
      throw new ActionFailure("creator_worker_binding_mismatch: creator worker descriptor is invalid");
    return { run, record };
  }

  async proceduralSources(runId: string, get: (id: string) => FlowRun): Promise<ProceduralSource[]> {
    const bound = await this.binding(runId, get);
    if (!bound) {
      let run = get(runId);
      for (let depth = 0; run.parent; depth++) {
        if (depth >= 8) throw new ActionFailure("creator_procedural_sources_unavailable");
        const parent = get(run.parent.runId);
        if (!parent.steps?.some(s => s.kind === "flow" && s.childRunId === run.id && s.stepKey === run.parent!.stepKey))
          throw new ActionFailure("creator_procedural_sources_unavailable");
        run = parent;
      }
      if (run.flow.id !== "veya/veya-world-agent") throw new ActionFailure("creator_procedural_sources_unavailable");
      return collectProceduralSources([{ run }], get);
    }
    const bytes = await readFile(this.path);
    if (bytes.length > 256 * 1024) throw new ActionFailure("creator_procedural_sources_unavailable");
    const bindings = (await readCreatorBindingDocument(this.projectRoot, bytes) as unknown as { bindings: Record<string, Binding> }).bindings;
    const pins = new Map<string, string>();
    for (const p of [...(bound.record.productionGrant?.proof.assets ?? []), ...(bound.record.materialsGrant?.proof.assets ?? [])])
      pins.set(p.assetId, p.contentHash);
    for (const item of bound.record.assetReuse?.items ?? []) {
      const b = item.binding; pins.set(b.assetId, b.version); pins.set(b.collisionAssetId, b.collisionVersion); pins.set(b.navigationAssetId, b.navigationVersion);
    }
    if (!pins.size) return collectProceduralSources([{ run: bound.run }], get);
    const roots: ProceduralRoot[] = [{ run: bound.run }], seen = new Set<string>();
    const visit = async (requestId: string, record: Binding): Promise<void> => {
      if (seen.has(requestId) || seen.size >= 32) throw new ActionFailure("creator_procedural_sources_unavailable");
      seen.add(requestId);
      let previousId: string | undefined;
      if (record.worldProductionRecoveryRef) {
        const grant = await readProductionGrant(this.projectRoot, record.worldProductionRecoveryRef);
        previousId = grant.recovery.sourceRequestId;
        validateProductionBinding(grant, record, bindings[previousId]);
      } else if (record.productionMaterialsRef) {
        const grant = await readMaterialsGrant(this.projectRoot, record.productionMaterialsRef);
        previousId = grant.materials.sourceRequestId;
        validateMaterialsBinding(grant, record, bindings[previousId]);
      } else if (record.assetReuse) {
        const grant = readAssetReuseGrant(record.assetReuse);
        previousId = grant.sourceRequestId;
        if (bindings[previousId]?.runId !== grant.sourceRunId || bindings[previousId]?.input?.text !== record.input?.text)
          throw new ActionFailure("creator_procedural_sources_unavailable");
      } else if (record.worldDesignRecovery) {
        const recovery = record.worldDesignRecovery as Record<string, JsonValue>;
        if (typeof recovery.sourceRequestId !== "string" || record.input?.previousRequestId !== recovery.sourceRequestId ||
            bindings[recovery.sourceRequestId]?.runId !== recovery.sourceRunId ||
            bindings[recovery.sourceRequestId]?.input?.text !== record.input.text)
          throw new ActionFailure("creator_procedural_sources_unavailable");
        previousId = recovery.sourceRequestId;
      }
      if (!previousId) return;
      const previous = bindings[previousId];
      if (!previous?.runId || ["playerId", "homeWorldId", "creationSessionId", "sessionPath"].some(k =>
        previous[k as keyof Binding] !== bound.record[k as keyof Binding])) throw new ActionFailure("creator_procedural_sources_unavailable");
      const run = get(previous.runId);
      if (run.requestId !== previousId || run.flow.id !== "veya/veya-wish" || !["completed", "failed"].includes(run.status))
        throw new ActionFailure("creator_procedural_sources_unavailable");
      roots.push({ run, pins });
      await visit(previousId, previous);
    };
    await visit(bound.run.requestId, bound.record);
    return collectProceduralSources(roots, get);
  }
}

/** Sanitized run context. The caller cannot supply a run, endpoint, budget or path. */
export class VeyaCreatorCapability implements AuraCapabilityClient {
  readonly bindings: VeyaCreatorBindings;
  readonly get: (id: string) => FlowRun;
  readonly worker: AuraCapabilityClient;
  constructor(bindings: VeyaCreatorBindings, get: (id: string) => FlowRun, worker: AuraCapabilityClient) {
    this.bindings = bindings; this.get = get; this.worker = worker;
  }

  async invoke(capability: string, operation: string, input: JsonValue, signal: AbortSignal,
    context?: { readonly runId?: string }): Promise<JsonValue> {
    signal.throwIfAborted();
    if (capability !== VEYA_CREATOR_CAPABILITY || operation !== "context" ||
        !input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "proceduralRefs") || !context?.runId)
      throw new ActionFailure("creator_context_unavailable");
    if (Object.hasOwn(input, "proceduralRefs")) {
      try {
        const requested = readProceduralRefs(input.proceduralRefs);
        const sources = await this.bindings.proceduralSources(context.runId, this.get);
        if (sources.length) verifyProceduralCatalog(sources,
          await this.worker.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.assets.list", {}, signal, context));
        return projectProceduralSources(sources, requested);
      } catch (error) {
        signal.throwIfAborted();
        throw new ActionFailure(error instanceof Error && error.message === "creator_context_capacity_exceeded" ? error.message : "creator_procedural_sources_unavailable");
      }
    }
    const bound = await this.bindings.binding(context.runId, this.get);
    if (!bound?.record.homeWorldId) throw new ActionFailure("creator_context_unavailable");
    let worker: Record<string, unknown>;
    try {
      const bytes = await readFile(bound.record.sessionPath);
      if (bytes.length > 8192) throw new Error("size");
      worker = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    } catch { throw new ActionFailure("creator_worker_binding_unavailable"); }
    if (worker.role !== "creator-worker") throw new ActionFailure("creator_worker_binding_mismatch");
    // Probe the actual bound process before returning any production context.
    // A role-only old worker must fail before planning dispatches paid work.
    let supported: JsonValue;
    try { supported = await this.worker.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.system.context", {}, signal, context); }
    catch (error) {
      signal.throwIfAborted();
      throw new ActionFailure("creator_worker_capabilities_unavailable", { cause: error });
    }
    const catalog = supported && typeof supported === "object" && !Array.isArray(supported) ? supported.tools : undefined;
    const names = new Set(Array.isArray(catalog) ? catalog.flatMap(item => item && typeof item === "object" &&
      !Array.isArray(item) && typeof item.name === "string" ? [item.name] : []) : []);
    const missing = CREATOR_REQUIRED_TOOLS.filter(name => !names.has(name));
    if (missing.length) throw new ActionFailure(`creator_worker_upgrade_required: ${missing.join(", ")}`);
    const system = supported && typeof supported === "object" && !Array.isArray(supported) ? supported.system : undefined;
    const verification = system && typeof system === "object" && !Array.isArray(system) ? system.creation_verification : undefined;
    const missingVerification = CREATOR_REQUIRED_VERIFICATION.filter(name => {
      const version = verification && typeof verification === "object" && !Array.isArray(verification) ? verification[name] : undefined;
      return typeof version !== "number" || !Number.isSafeInteger(version) || version < 1;
    });
    if (missingVerification.length) throw new ActionFailure(
      `creator_worker_upgrade_required: creation_verification.${missingVerification.join(", creation_verification.")}`,
    );
    let assetReuse: AssetReuseGrant | undefined;
    if (bound.record.assetReuse || bound.record.input?.reuseAssetsFromRequestId) {
      try {
        assetReuse = readAssetReuseGrant(bound.record.assetReuse);
        const inherited = !!bound.record.worldDesignRecovery;
        if (bound.record.input?.operation !== "create_world" || bound.record.recovery || bound.record.previousArtifact ||
            (!inherited && (assetReuse.sourceRequestId !== bound.record.input.reuseAssetsFromRequestId || bound.record.recoveryBudgetCreationId)))
          throw new Error("asset_reuse_unavailable");
        const catalog = await this.worker.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.assets.list", {}, signal, context);
        verifyAssetReuseCatalog(assetReuse, catalog);
      } catch (error) {
        signal.throwIfAborted();
        throw new ActionFailure(error instanceof Error && error.message === "asset_reuse_catalog_mismatch" ? error.message : "asset_reuse_unavailable");
      }
    }
    // Count ceilings are host configuration; monetary ceilings are checked again
    // at every paid stage by the shared project ledger.
    const budget = { maxAiAssets: 6, maxCharacters: 2, maxRepairRounds: 3, maxSkyImages: 0 };
    try {
      const config = JSON.parse(await readFile(join(this.bindings.projectRoot, ".aura", "world-agent-budget.json"), "utf8"));
      for (const key of Object.keys(budget) as (keyof typeof budget)[])
        if (Number.isInteger(config[key]) && config[key] >= 0 && config[key] <= budget[key]) budget[key] = config[key];
      if (Number.isInteger(config.maxSkyImages) && config.maxSkyImages >= 0 && config.maxSkyImages <= 1)
        budget.maxSkyImages = config.maxSkyImages;
    } catch { /* Count defaults stay available; paid stages validate the monetary policy separately. */ }
    if (bound.record.craftAuthorization) {
      budget.maxAiAssets = Math.min(budget.maxAiAssets, 1); budget.maxCharacters = 0; budget.maxSkyImages = 0;
    }
    if (bound.record.productionGrant) {
      const grant = bound.record.productionGrant;
      // The first durable context performs admission. Subsequent child contexts
      // inherit that receipt: a successful compose may legitimately advance the
      // draft in this same Run, so never compare it to the old source revision.
      const admitted = bound.run.steps.some(step => step.kind === "action" && step.actionId === "veya/creator-context" &&
        step.status === "completed" && step.output && typeof step.output === "object" && !Array.isArray(step.output) &&
        productionDigest(step.output.worldProductionRecovery) === productionDigest(grant.recovery));
      if (!admitted) {
        try { await verifyProductionWorker(grant, (op, body) => this.worker.invoke(VEYA_WORLD_AGENT_CAPABILITY, op, body, signal, context), budget.maxRepairRounds); }
        catch { signal.throwIfAborted(); throw new ActionFailure("creator_production_recovery_state_changed"); }
      }
    }
    if (bound.record.materialsGrant) {
      try { await verifyMaterialsWorker(bound.record.materialsGrant, (op, body) => this.worker.invoke(VEYA_WORLD_AGENT_CAPABILITY, op, body, signal, context)); }
      catch { signal.throwIfAborted(); throw new ActionFailure("creator_production_materials_state_changed"); }
    }
    let proceduralRefs;
    try {
      const sources = await this.bindings.proceduralSources(context.runId, this.get);
      if (sources.length) {
        verifyProceduralCatalog(sources, await this.worker.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.assets.list", {}, signal, context));
        proceduralRefs = sources.map(source => source.ref);
      }
    } catch { signal.throwIfAborted(); throw new ActionFailure("creator_procedural_sources_unavailable"); }
    const result: JsonValue = { schemaVersion: 1, creationId: bound.run.requestId, homeWorldId: bound.record.homeWorldId,
      ...(bound.record.craftAuthorization ? { craftAuthorization: bound.record.craftOriginalAuthorization ?? bound.record.craftAuthorization } : {}),
      operation: bound.record.input?.operation ?? (bound.record.kind === "prop" ? "create_prop" : "create_world"),
      ...(bound.record.input?.targetWorldId ? { targetWorldId: bound.record.input.targetWorldId } : {}),
      ...(bound.record.input?.target ? { target: bound.record.input.target } : {}),
      ...(bound.record.previousArtifact ? { previousArtifact: bound.record.previousArtifact } : {}),
      ...(bound.record.input?.artifactTarget ? { artifactTarget: bound.record.input.artifactTarget } :
        bound.record.previousArtifact && bound.record.input?.target ? { artifactTarget: {
          allowedEntityIds: bound.record.input.target.allowedEntityIds, allowSpawnChange: bound.record.input.target.allowSpawnChange,
        } } : {}),
      ...(bound.record.recovery ? { recovery: bound.record.recovery } : {}),
      ...(bound.record.worldDesignRecovery ? { worldDesignRecovery: bound.record.worldDesignRecovery } : {}),
      ...(bound.record.productionGrant ? { worldProductionRecovery: bound.record.productionGrant.recovery as unknown as JsonValue } : {}),
      ...(bound.record.materialsGrant ? { productionMaterials: bound.record.materialsGrant.materials as unknown as JsonValue } : {}),
      ...(assetReuse ? { assetReuse } : {}),
      ...(proceduralRefs ? { proceduralRefs } : {}),
      budget, worker: { role: "creator-worker", platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "unknown" } };
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new ActionFailure("creator_context_capacity_exceeded");
    return result;
  }
}
