import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { createHash } from "node:crypto";
import { cookerSubmissionFingerprint, productionDigest, validateProductionGrant, validateMaterialsGrant, materialSubmissionFingerprint,
  expectedAtmosphereSources, environmentShaderPins, matchesEnvironmentShader,
  type ProductionGrant, type AssetReuseGrant, type MaterialsGrant } from "@aura/orchestration";
import { retainedWorldDesign, type WorldDesignRecovery } from "./veya-creator-world-design-recovery.ts";
import { retainedCommonAssets } from "./veya-creator-asset-reuse.ts";
import { completedAtmosphereCache } from "./veya-creator-atmosphere-cache.ts";

const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(object(v)!).sort().map(k => [k, canonical(object(v)![k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = /^[a-f0-9]{64}$/u;
const reads = new Set(["veya/creator-context", "veya/system-context", "veya/world-list", "veya/world-status", "veya/world-read",
  "veya/asset-list", "veya/cooker-capabilities", "veya/draft-read", "veya/creation-module-read", "veya/runtime-observe",
  "veya/runtime-inspect", "veya/character-inspect", "veya/operation-status", "veya/cooker-status"]);
const productionFlows = new Set(["veya/veya-wish", "veya/veya-world-agent", "veya/veya-world-plan", "veya/veya-world-gameplay-design",
  "veya/veya-world-build", "veya/veya-world-assets", "veya/veya-asset-batch", "veya/veya-procedural-asset", "veya/veya-prop-agent", "veya/veya-prop-prepare",
  "veya/veya-scene-layout", "veya/veya-environment-lighting", "veya/veya-world-behavior", "veya/veya-world-effects", "veya/veya-world-lookdev",
  "veya/veya-world-verify", "veya/veya-verify-baseline", "veya/veya-verify-interaction", "veya/veya-verify-visual",
  "veya/veya-verify-effect", "veya/veya-verify-effect-batch"]);
const writers: Record<string, string[]> = {
  "veya/world-copy": ["veya/veya-world-agent"], "veya/travel-enter": ["veya/veya-world-agent"],
  "veya/draft-create": ["veya/veya-world-agent"], "veya/draft-compose": ["veya/veya-world-build"],
  "veya/creation-module-write": ["veya/veya-prop-agent", "veya/veya-scene-layout", "veya/veya-environment-lighting", "veya/veya-world-behavior", "veya/veya-world-effects"],
  "veya/cooker-submit": ["veya/veya-prop-prepare", "veya/veya-procedural-asset", "veya/veya-environment-lighting", "veya/veya-world-effects"],
  "veya/atmosphere-build": ["veya/veya-environment-lighting"],
};
const testActions = new Set(["veya/playtest-begin", "veya/playtest-end", "veya/playtest-save-resume", "veya/character-navigate",
  "veya/action-perform", "veya/dialogue-choose", "veya/world-preview", "veya/world-performance", "veya/effect-preview", "veya/world-validate"]);
export const hasWorldProductionResume = (root: FlowRun): boolean => !!object(object(object(root.output)?.result)?.resume);
const schemaFailure = "步骤 Schema 必须可无损表示为受支持的 JSON Schema。";
function pendingQuestions(value: unknown): boolean {
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(v);
  const text = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max;
  const fields = ["questionId", "field", "title", "context", "kind", "blocking", "options", "minSelections", "maxSelections"];
  return Array.isArray(value) && value.length > 0 && value.length <= 3 &&
    new Set(value.map(q => object(q)?.questionId)).size === value.length && value.every(v => {
      const q = object(v);
      return q && Object.keys(q).length === fields.length && fields.every(k => Object.hasOwn(q, k)) &&
        id(q.questionId) && id(q.field) && text(q.title, 1, 512) && text(q.context, 0, 1000) &&
        ["single", "multiple", "text"].includes(q.kind) && typeof q.blocking === "boolean" &&
        Array.isArray(q.options) && q.options.length <= 12 && q.options.every((o: any) => object(o) &&
          Object.keys(o).length === 2 && id(o.id) && text(o.label, 1, 256)) &&
        Number.isInteger(q.minSelections) && q.minSelections >= 0 && q.minSelections <= 12 &&
        Number.isInteger(q.maxSelections) && q.maxSelections >= 1 && q.maxSelections <= 12 &&
        (q.kind === "text" || (q.options.length > 0 &&
          new Set(q.options.map((o: any) => o.id)).size === q.options.length &&
          q.minSelections <= q.maxSelections && q.maxSelections <= q.options.length));
    });
}

/** One terminal production checkpoint, one next repair round. No rejected or
 * completed Run is rewritten, and unknown side effects never become retries. */
export async function retainedWorldProduction(root: FlowRun, sourceRequestId: string, get: (id: string) => Promise<FlowRun>,
  identity: ProductionGrant["identity"], trusted: { design?: WorldDesignRecovery; assets?: AssetReuseGrant; production?: ProductionGrant; productionMaterials?: MaterialsGrant },
  maxRepairRounds = 3): Promise<ProductionGrant> {
  function refuse(): never { throw new Error("world_production_recovery_unavailable"); }
  const ri = object(root.input), ro = object(root.output);
  // Only the host's pre-durable serialization fault: no checkpoint, answer or
  // partial child is inferred. The old failed Run remains untouched.
  const preCheckpointFailure = root.status === "failed" && root.error === schemaFailure && root.output === undefined &&
    !root.commands?.length && !root.recoveryEvents?.length &&
    !!trusted.production && root.steps.length === 2 &&
    root.steps.filter(s => s.kind === "action" && s.actionId === "veya/creator-context" && s.status === "completed").length === 1 &&
    root.steps.filter(s => s.kind === "flow" && s.status === "completed" && s.childRunId).length === 1;
  if (root.flow.id !== "veya/veya-wish" || root.requestId !== sourceRequestId ||
      (!preCheckpointFailure && (root.status !== "completed" || ro?.status !== "blocked")) ||
      ri?.operation !== "create_world" || ri.homeWorldId !== identity.homeWorldId || ri.previousArtifactId || ri.references?.length ||
      typeof ri.text !== "string" || createHash("sha256").update(ri.text).digest("hex") !== identity.textHash) refuse();
  const runs: FlowRun[] = [], completedOperations: ProductionGrant["proof"]["completedOperations"] = [];
  const scanUnknown = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(scanUnknown);
    else if (object(v)) {
      if (object(v)?.costs?.status === "unknown" || ["prop_cook_submission_failed", "prop_cook_pending", "paid_result_unknown"].includes(String(object(v)?.code))) refuse();
      Object.values(object(v)!).forEach(scanUnknown);
    }
  };
  async function visit(run: FlowRun, depth: number) {
    if (depth > 8 || runs.length >= 128 || runs.some(r => r.id === run.id) || !productionFlows.has(run.flow.id) ||
        (run.status !== "completed" && !(run.id === root.id && preCheckpointFailure))) refuse();
    if (run.flow.id === "veya/veya-asset-batch" && (!Array.isArray(object(run.input)?.requirements) || object(run.input)!.requirements.length > 16)) refuse();
    runs.push(run); scanUnknown(run.output);
    for (const step of run.steps) {
      const knownRefusal = step.kind === "action" && step.status === "failed" &&
        (step.actionId === "veya/draft-compose" && /^Veya [a-z][a-z0-9_]{0,95} \(HTTP (400|409|422)\)\./u.test(step.error ?? "") ||
         step.actionId === "veya/cooker-submit" && /^Veya (invalid_lua_source|invalid_pipeline|invalid_cooker_input) \(HTTP 400\)\./u.test(step.error ?? ""));
      if (step.status !== "completed" && !knownRefusal) refuse();
      if (step.kind === "flow") {
        if (!step.childRunId) refuse();
        const child = await get(step.childRunId);
        if (child.id !== step.childRunId || child.parent?.runId !== run.id || child.parent.stepKey !== step.stepKey) refuse();
        await visit(child, depth + 1);
      } else if (step.kind === "agent") {
        // Production source Agents declare reads only; verifier navigation still
        // operates inside an owned playtest and cannot produce modules/assets.
        if (!Array.isArray(step.actions) || step.actions.some(a => !hash.test(a.sourceHash) ||
          (!reads.has(a.id) && !(run.flow.id.includes("verify") && a.id === "veya/character-navigate")))) refuse();
      } else if (step.kind === "action") {
        if (!reads.has(step.actionId) && !writers[step.actionId]?.includes(run.flow.id) &&
            !(run.flow.id.includes("verify") && testActions.has(step.actionId))) refuse();
        if (knownRefusal) continue;
        const output = object(step.output);
        if (typeof output?.operation_id === "string" && !["succeeded", "failed", "cancelled"].includes(output.status)) {
          const ended = run.steps.filter(s => s.kind === "action" && ["veya/cooker-status", "veya/operation-status"].includes(s.actionId) &&
            object(s.input)?.operationId === output.operation_id && object(s.output)?.operation_id === output.operation_id &&
            ["succeeded", "failed", "cancelled"].includes(object(s.output)?.status));
          if (ended.length !== 1) refuse();
        }
        if (["veya/cooker-submit", "veya/atmosphere-build"].includes(step.actionId)) {
          const waits = run.steps.filter(s => s.kind === "action" && s.actionId === "veya/cooker-status" &&
            object(s.input)?.operationId === output?.operation_id && object(s.output)?.operation_id === output?.operation_id &&
            ["succeeded", "failed", "cancelled"].includes(object(s.output)?.status));
          if (waits.length > 1 || output?.status === "succeeded" && waits.length) refuse();
          const done = output?.status === "succeeded" ? output : object(waits[0]?.output);
          if (!done || !["succeeded", "failed", "cancelled"].includes(done.status)) refuse();
          if (step.actionId === "veya/atmosphere-build" && object(step.input)?.source !== "procedural") refuse();
          if (done.status === "succeeded") {
            const cache = step.actionId === "veya/atmosphere-build" && !Object.hasOwn(done, "cooker") &&
              done === output && completedAtmosphereCache(run, step);
            if (!cache && (done.cooker?.ok !== true || !Array.isArray(done.cooker.steps) || !done.cooker.steps.length ||
                done.cooker.steps.some((s: any) => s.ok !== true || s.error !== 0))) refuse();
            if (step.actionId === "veya/atmosphere-build") {
              const expected = expectedAtmosphereSources(step.input);
              if (expected && (!Array.isArray(done.assets) || done.assets.length !== 1 ||
                  done.assets[0]?.type !== "environment" || done.assets[0]?.atmosphere?.shader_sha256 !== expected.shader_sha256)) refuse();
              completedOperations.push({ operation: "veya.atmosphere.build", operationId: done.operation_id,
                fingerprint: materialSubmissionFingerprint("veya.atmosphere.build", step.input) });
            } else completedOperations.push({ operationId: done.operation_id, fingerprint: cookerSubmissionFingerprint(step.input) });
          }
        }
      } else refuse(); // Incomplete/answered checkpoints require their own durable continuation.
    }
  }
  await visit(root, 0);
  const worlds = runs.filter(r => r.flow.id === "veya/veya-world-agent" && r.parent?.runId === root.id);
  if (worlds.length !== 1) refuse();
  const world = worlds[0]!, wi = object(world.input)!, wo = object(world.output);
  const resume = object(wo?.resume);
  if (preCheckpointFailure && (wo?.status !== "needs_attention" || !pendingQuestions(wo.questions) ||
      !same(wi.brief, trusted.production!.recovery.brief) || resume?.round !== trusted.production!.recovery.nextRound)) refuse();
  if (!resume || (!preCheckpointFailure && (!same(ro?.result, wo) || !same(ro?.brief, wi.brief))) || wi.outputMode !== "artifact" || wi.prior ||
      !same(wi.continuation ?? [], []) || !same(resume.plan?.requirements, wi.brief) ||
      !Number.isInteger(resume.round) || resume.round < 0 || resume.round >= Math.min(3, maxRepairRounds) ||
      !hash.test(resume.generationScope) || !same(resume.gameplay?.spec, resume.build?.gameplaySpec) ||
      resume.gameplay?.status !== "ready" || productionDigest(resume.gameplay.spec) !== resume.gameplay.specHash ||
      resume.draft?.world_id !== resume.worldId || !hash.test(resume.draft?.content_hash)) refuse();
  const contexts = [root, world].map(r => r.steps.filter(s => s.kind === "action" && s.actionId === "veya/creator-context"));
  if (contexts.some(s => s.length !== 1 || object(s[0]!.output)?.creationId !== sourceRequestId ||
      object(s[0]!.output)?.homeWorldId !== identity.homeWorldId || object(s[0]!.output)?.operation !== "create_world") ||
      !same(contexts[0]![0]!.output, contexts[1]![0]!.output)) refuse();
  const context = object(contexts[0]![0]!.output)!;
  // This is host-admitted provenance, never material JSON returned by a model.
  // The route reconstructs its original successful producer subtree first.
  const materials = trusted.productionMaterials ? validateMaterialsGrant(trusted.productionMaterials) : undefined;
  if (!same(context.productionMaterials, materials?.materials)) refuse();
  if (materials) {
    const m = materials.materials, i = materials.identity;
    if (trusted.production || trusted.design || trusted.assets || ri.previousRequestId ||
        ri.reuseProductionFromRequestId !== m.sourceRequestId || i.requestTextHash !== identity.textHash ||
        ["playerId", "homeWorldId", "creationSessionId"].some(k => object(i)![k] !== object(identity)![k]) ||
        (wi.productionMaterials !== undefined && !same(wi.productionMaterials, m)) || !same(resume.build.assets, m.common) ||
        !same(resume.plan.assets, object(m.sourcePlan)?.assets) ||
        !same(resume.plan.atmosphere, object(m.sourcePlan)?.atmosphere) ||
        !same(resume.plan.lookIntent, object(m.sourcePlan)?.lookIntent) ||
        m.props.some(p => !resume.gameplay.spec.props?.some((s: any) => same(s, object(p)?.spec)))) refuse();
    completedOperations.push(...materials.proof.completedOperations);
  }
  const designs = runs.filter(r => r.flow.id === "veya/veya-world-gameplay-design");
  const plans = runs.filter(r => r.flow.id === "veya/veya-world-plan");
  if (trusted.production) {
    const prior = validateProductionGrant(trusted.production);
    if (!same(prior.identity, identity) || !same(context.worldProductionRecovery, prior.recovery) || context.assetReuse || context.worldDesignRecovery ||
        !same(wi.resume, { ...object(prior.recovery.resume), round: prior.recovery.nextRound }) || !same(wi.brief, prior.recovery.brief) || designs.length || plans.length ||
        resume.worldId !== object(prior.recovery.resume)?.worldId || resume.generationScope !== object(prior.recovery.resume)?.generationScope ||
        !same(resume.plan, object(prior.recovery.resume)?.plan) || !same(resume.gameplay, object(prior.recovery.resume)?.gameplay) ||
        resume.round < prior.recovery.nextRound) refuse();
    completedOperations.push(...prior.proof.completedOperations);
  } else {
    if (context.worldProductionRecovery || designs.length !== 1 || designs[0]!.parent?.runId !== world.id ||
        !same(designs[0]!.output, resume.gameplay) || !same(object(designs[0]!.input)?.plan, { ...resume.plan,
          returnHome: { schemaVersion: 1, binding: "personal_home", entityId: "return_home", arrival: "home_return" } })) refuse();
    if (trusted.design) {
      const prior = trusted.design, ancestor = await get(prior.sourceRunId);
      const ac = ancestor.steps.find(s => s.kind === "action" && s.actionId === "veya/creator-context");
      const rebuilt = await retainedWorldDesign(ancestor, prior.sourceRequestId, get, object(ac?.output)?.worldDesignRecovery as WorldDesignRecovery | undefined);
      if (!same(rebuilt, prior) || !same(context.worldDesignRecovery, prior) || !same(wi.designRecovery, prior) || plans.length ||
          !same(prior.plan, resume.plan) || !same(prior.brief, wi.brief)) refuse();
    } else if (plans.length !== 1 || plans[0]!.parent?.runId !== world.id || !same(object(plans[0]!.input)?.brief, wi.brief) ||
        !same(plans[0]!.output, resume.plan) || context.worldDesignRecovery || wi.designRecovery) refuse();
  }
  if (!same(context.assetReuse, trusted.assets) || context.recovery) refuse();
  if (trusted.assets) {
    const source = await get(trusted.assets.sourceRunId), proven = await retainedCommonAssets(source, trusted.assets.sourceRequestId, get);
    if (!same(proven, trusted.assets)) refuse();
    for (const item of proven.items) {
      if (!resume.plan.assets.some((r: any) => same(r, item.requirement)) ||
          !resume.build.assets?.bindings?.some((b: any) => same(b, item.binding))) refuse();
      const producer = await get(item.producer.runId);
      const submit = producer.steps.find(s => s.kind === "action" && s.actionId === "veya/cooker-submit");
      if (!submit || submit.kind !== "action") refuse();
      completedOperations.push({ operationId: item.producer.operationId, fingerprint: cookerSubmissionFingerprint(submit.input) });
    }
  }
  const builds = runs.filter(r => r.flow.id === "veya/veya-world-build" && r.parent?.runId === world.id);
  const last = builds.at(-1);
  if (!last || !same(last.output, resume.build) || object(last.input)?.repairRound !== resume.round ||
      object(last.input)?.draftId !== resume.draft.draft_id || !same(object(last.input)?.plan, { ...resume.plan, targetWorldId: resume.worldId,
        returnHome: { schemaVersion: 1, binding: "personal_home", entityId: "return_home", arrival: "home_return" } }) ||
      !same(object(last.input)?.gameplaySpec, resume.gameplay.spec)) refuse();
  for (const build of builds) if (object(build.input)?.generationScope !== resume.generationScope) refuse();
  // Retained modules/assets must be exact durable specialist output or prior
  // admitted output. A coordinator cannot manufacture a ready child result.
  const candidates: unknown[] = runs.map(r => r.output);
  if (materials) {
    candidates.push(materials.materials.common, ...materials.materials.props);
    // The shared result schema adds only this empty optional cost-record list.
    // Do not broadly strip defaults or normalize source/spec/module identities.
    for (const prop of materials.materials.props) {
      const normalized = structuredClone(prop), costs = object(object(object(normalized)?.effects)?.costs);
      if (costs && costs.records === undefined) { costs.records = []; candidates.push(normalized); }
    }
  }
  if (trusted.production) {
    const collect = (v: unknown) => { if (Array.isArray(v)) v.forEach(collect); else if (object(v)) { candidates.push(v); Object.values(object(v)!).forEach(collect); } };
    collect(object(trusted.production.recovery.resume)?.build);
  }
  if (!candidates.some(v => same(v, resume.build.assets))) refuse();
  for (const held of [...(resume.build.props ?? []), ...(resume.build.retainedProduction ? [resume.build.retainedProduction.result] : [])]) {
    const { lockedSpec, ...result } = held;
    if (!candidates.some(v => same(v, held) || lockedSpec && same(v, result)) ||
        lockedSpec && !resume.gameplay.spec.props?.some((p: any) => same(p, lockedSpec))) refuse();
  }
  const nativeSteps = runs.flatMap(r => r.steps.filter(s => s.kind === "action"));
  for (const step of nativeSteps) if (step.kind === "action") {
    const input = object(step.input), output = object(step.output);
    if (step.actionId === "veya/world-copy" && (trusted.production || input?.worldId !== resume.plan.targetWorldId)) refuse();
    if (step.actionId === "veya/travel-enter" && input?.worldId !== resume.worldId) refuse();
    if (step.actionId === "veya/draft-create" && (trusted.production || input?.worldId !== resume.worldId ||
        output?.draft_id !== resume.draft.draft_id || output?.world_id !== resume.worldId)) refuse();
    if (["veya/draft-compose", "veya/playtest-begin"].includes(step.actionId) && input?.draftId !== resume.draft.draft_id) refuse();
  }
  if (nativeSteps.filter(s => s.kind === "action" && s.actionId === "veya/world-copy").length > (trusted.production ? 0 : 1) ||
      nativeSteps.filter(s => s.kind === "action" && s.actionId === "veya/draft-create").length !== (trusted.production ? 0 : 1)) refuse();
  const snapshots = nativeSteps.filter(s => s.kind === "action" && s.actionId === "veya/world-read" &&
    object(s.input)?.worldId === resume.worldId && object(s.output)?.manifest?.world_id === resume.worldId);
  const snap = object(snapshots.at(-1)?.output), priorWorld = trusted.production?.proof.world;
  const worldProof = snap ? { worldId: resume.worldId, ownerId: snap.manifest.owner_id, revision: snap.revision, contentHash: snap.content_hash } : priorWorld;
  if (!worldProof || worldProof.revision !== resume.draft.base_revision) refuse();
  const receipts = nativeSteps.map(s => s.output);
  if (!receipts.some(v => object(v)?.draft_id === resume.draft.draft_id && same(v, resume.draft)) &&
      !same(object(trusted.production?.recovery.resume)?.draft, resume.draft)) refuse();
  const draftReceipts = nativeSteps.filter(s => s.kind === "action" && ["veya/draft-create", "veya/draft-read", "veya/draft-compose"].includes(s.actionId) &&
    s.status === "completed" && object(s.output)?.draft_id === resume.draft.draft_id && object(s.output)?.world_id === resume.worldId)
    .sort((a, b) => Number(object(a.output)?.draft_revision) - Number(object(b.output)?.draft_revision));
  for (const step of draftReceipts) if (draftReceipts.some(other => object(other.output)?.draft_revision === object(step.output)?.draft_revision &&
      object(other.output)?.content_hash !== object(step.output)?.content_hash)) refuse();
  const currentDraft = draftReceipts.at(-1)?.output ?? trusted.production?.proof.draft;
  if (!object(currentDraft) || object(currentDraft)!.base_revision !== resume.draft.base_revision) refuse();
  const assets = new Map<string, string>(), modules = new Map<string, string>();
  const pin = (id: unknown, version: unknown) => {
    if (typeof id !== "string" || !hash.test(String(version)) || (assets.has(id) && assets.get(id) !== version)) refuse();
    assets.set(id, version as string);
  };
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (object(v)) {
      const o = object(v)!;
      if (o.module_id) { if (!hash.test(o.module_id) || !hash.test(o.content_hash) || modules.has(o.module_id) && modules.get(o.module_id) !== o.content_hash) refuse(); modules.set(o.module_id, o.content_hash); }
      if (o.assetId !== undefined && o.version !== undefined) pin(o.assetId, o.version);
      if (o.assetId !== undefined && o.contentHash !== undefined) pin(o.assetId, o.contentHash);
      if (o.asset_id !== undefined && o.content_hash !== undefined) pin(o.asset_id, o.content_hash);
      if (o.sourceAssetId) pin(o.sourceAssetId, o.sourceContentHash);
      if (o.collisionAssetId) {
        if (o.collisionVersion !== undefined && o.collisionContentHash !== undefined && o.collisionVersion !== o.collisionContentHash) refuse();
        pin(o.collisionAssetId, o.collisionVersion ?? o.collisionContentHash);
      }
      if (o.navigationAssetId) pin(o.navigationAssetId, o.navigationVersion);
      if (o.asset_versions) for (const [id, version] of Object.entries(o.asset_versions)) pin(id, version);
      Object.values(o).forEach(collect);
    }
  };
  collect(resume.draft); collect(currentDraft); collect(resume.build); if (snap?.manifest) collect(snap.manifest);
  // Retained modules are opaque refs; their admitted dependencies remain pinned
  // even when this round has no new module-read receipt containing its assets.
  for (const a of trusted.production?.proof.assets ?? []) pin(a.assetId, a.contentHash);
  for (const a of materials?.proof.assets ?? []) pin(a.assetId, a.contentHash);
  for (const [moduleId, contentHash] of modules) {
    const receipt = receipts.find(v => object(v)?.module_id === moduleId && object(v)?.content_hash === contentHash);
    if (!receipt && !trusted.production?.proof.modules.some(m => m.moduleId === moduleId && m.contentHash === contentHash) &&
        !materials?.proof.modules.some(m => m.moduleId === moduleId && m.contentHash === contentHash)) refuse();
    if (receipt) collect(receipt);
  }
  const catalogs = nativeSteps.filter(s => s.kind === "action" && s.actionId === "veya/asset-list").map(s => object(s.output));
  const priorShaderPins = environmentShaderPins([trusted.production?.recovery.resume, materials?.materials.environmentResource]);
  for (const p of environmentShaderPins(resume.build)) {
    const inherited = priorShaderPins.some(a => same(a, p));
    // Only a previous host proof or an actual native catalog/terminal Cooker
    // asset can support a shader identity retained from model-authored output.
    if (!inherited && (!catalogs.some(c => matchesEnvironmentShader(p, c?.[p.assetId])) ||
        !nativeSteps.some(s => object(s.output)?.status === "succeeded" &&
          object(s.output)?.assets?.some((a: any) => a.id === p.assetId && matchesEnvironmentShader(p, a))))) refuse();
  }
  for (const [id, version] of assets) if (!catalogs.some(c => c?.[id]?.content_hash === version) &&
      !trusted.production?.proof.assets.some(a => a.assetId === id && a.contentHash === version) &&
      !materials?.proof.assets.some(a => a.assetId === id && a.contentHash === version)) refuse();
  const grant: ProductionGrant = { version: 1, identity, recovery: { schemaVersion: 1, sourceRequestId, sourceRunId: root.id,
    brief: wi.brief, continuation: [], resume: resume as JsonValue, resumeHash: productionDigest(resume), noNewPaidWork: true, nextRound: resume.round + 1 },
    proof: { world: worldProof, draft: currentDraft as JsonValue, assets: [...assets].map(([assetId, contentHash]) => ({ assetId, contentHash })),
      modules: [...modules].map(([moduleId, contentHash]) => ({ moduleId, contentHash })),
      completedOperations: [...new Map(completedOperations.map(op => [(op.operation ?? "veya.cooker.submit") + op.fingerprint, op])).values()] } };
  return validateProductionGrant(grant);
}
