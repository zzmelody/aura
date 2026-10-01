import type { FlowRun } from "@aura/protocol/types";
import { createHash } from "node:crypto";
import { materialIdentity, materialSubmissionFingerprint, productionDigest, validateMaterialsGrant, validateProductionGrant,
  expectedAtmosphereSources, environmentShaderPins, matchesEnvironmentShader,
  type MaterialsGrant, type ProductionGrant } from "@aura/orchestration";

const obj = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const same = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : materialIdentity(a) === materialIdentity(b);
const hash = /^[a-f0-9]{64}$/u;
const reads = new Set(["veya/creator-context", "veya/system-context", "veya/world-list", "veya/world-status", "veya/world-read", "veya/asset-list",
  "veya/cooker-capabilities", "veya/draft-read", "veya/creation-module-read", "veya/operation-status", "veya/cooker-status"]);
const flows = new Set(["veya-wish", "veya-world-agent", "veya-world-build", "veya-world-assets", "veya-asset-batch", "veya-prop-agent",
  "veya-prop-prepare", "veya-scene-layout", "veya-environment-lighting", "veya-world-behavior", "veya-world-effects"] .map(id => "veya/" + id));
const writes: Record<string, string[]> = { "veya/creation-module-write": ["veya-prop-agent", "veya-scene-layout", "veya-environment-lighting", "veya-world-behavior"],
  "veya/cooker-submit": ["veya-prop-prepare"], "veya/atmosphere-build": ["veya-environment-lighting"], "veya/draft-compose": ["veya-world-build"],
  "veya/travel-enter": ["veya-world-agent"] };

/** Extract immutable inputs for a separate new task, never a retry allowance.
 * v1 admits a terminal, host-admitted production subtree with no new design or
 * playtest. Its original grant is independently reconstructed by the route. */
export async function retainedProductionMaterials(root: FlowRun, sourceRequestId: string, get: (id: string) => Promise<FlowRun>,
  prior: ProductionGrant, newText: string = String(obj(root.input)?.text ?? "")): Promise<MaterialsGrant> {
  validateProductionGrant(prior);
  function refuse(): never { throw new Error("production_materials_unavailable"); }
  const runs: FlowRun[] = [], operations: MaterialsGrant["proof"]["completedOperations"] = prior.proof.completedOperations.map(op => ({ ...op, operation: op.operation ?? "veya.cooker.submit" }));
  const unknown = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(unknown);
    else if (obj(v)) { if (obj(v)?.costs?.status === "unknown" || ["prop_cook_submission_failed", "prop_cook_pending", "paid_result_unknown"].includes(String(obj(v)?.code))) refuse(); Object.values(obj(v)!).forEach(unknown); }
  };
  async function visit(run: FlowRun, depth: number): Promise<void> {
    if (depth > 8 || runs.length >= 128 || runs.some(r => r.id === run.id) || !flows.has(run.flow.id) || run.status !== "completed") refuse();
    runs.push(run); unknown(run.output);
    if (run.flow.id === "veya/veya-asset-batch" && (!Array.isArray(obj(run.input)?.requirements) || obj(run.input)!.requirements.length > 16)) refuse();
    for (const s of run.steps) {
      const denied = s.kind === "action" && s.actionId === "veya/draft-compose" && s.status === "failed" && /^Veya [a-z][a-z0-9_]{0,95} \(HTTP (400|409|422)\)\./u.test(s.error ?? "");
      if (s.status !== "completed" && !denied) refuse();
      if (s.kind === "flow") { if (!s.childRunId) refuse(); const child = await get(s.childRunId); if (child.id !== s.childRunId || child.parent?.runId !== run.id || child.parent.stepKey !== s.stepKey) refuse(); await visit(child, depth + 1); }
      else if (s.kind === "agent") { if (!Array.isArray(s.actions) || s.actions.some(a => !hash.test(a.sourceHash) || !reads.has(a.id))) refuse(); }
      else if (s.kind === "action") {
        if (!reads.has(s.actionId) && !writes[s.actionId]?.some(id => run.flow.id === "veya/" + id)) refuse();
        if (s.actionId === "veya/draft-compose" && obj(s.input)?.draftId !== obj(prior.recovery.resume)?.draft?.draft_id) refuse();
        if (s.actionId === "veya/travel-enter" && obj(s.input)?.worldId !== obj(prior.recovery.resume)?.worldId) refuse();
        if (denied) continue;
        const output = obj(s.output);
        const end = output?.operation_id && run.steps.find(x => x.kind === "action" && ["veya/cooker-status", "veya/operation-status"].includes(x.actionId) &&
          obj(x.input)?.operationId === output.operation_id && obj(x.output)?.operation_id === output.operation_id && ["succeeded", "failed", "cancelled"].includes(obj(x.output)?.status));
        if (output?.operation_id && !["succeeded", "failed", "cancelled"].includes(output.status) && !end) refuse();
        if (["veya/cooker-submit", "veya/atmosphere-build"].includes(s.actionId)) {
          const ends = run.steps.filter(x => x.kind === "action" && x.actionId === "veya/cooker-status" &&
            obj(x.input)?.operationId === output?.operation_id && obj(x.output)?.operation_id === output?.operation_id &&
            ["succeeded", "failed", "cancelled"].includes(obj(x.output)?.status));
          if (ends.length > 1 || output?.status === "succeeded" && ends.length) refuse();
          const done = output?.status === "succeeded" ? output : obj(end?.output);
          if (done?.status !== "succeeded" || done.cooker?.ok !== true || !Array.isArray(done.cooker.steps) || !done.cooker.steps.length || done.cooker.steps.some((x: any) => x.ok !== true || x.error !== 0)) refuse();
          if (s.actionId === "veya/atmosphere-build" && obj(s.input)?.source !== "procedural") refuse();
          if (s.actionId === "veya/atmosphere-build") {
            const expected = expectedAtmosphereSources(s.input);
            if (expected && (!Array.isArray(done.assets) || done.assets.length !== 1 || done.assets[0]?.type !== "environment" ||
                done.assets[0]?.atmosphere?.shader_sha256 !== expected.shader_sha256)) refuse();
          }
          const operation = s.actionId === "veya/cooker-submit" ? "veya.cooker.submit" : "veya.atmosphere.build";
          operations.push({ operation, operationId: done.operation_id, fingerprint: materialSubmissionFingerprint(operation, s.input) });
        }
      } else refuse();
    }
  }
  if (typeof newText !== "string" || newText.trim().length < 2 || newText.length > 4000 || root.requestId !== sourceRequestId || root.flow.id !== "veya/veya-wish" || obj(root.output)?.status !== "blocked" ||
      obj(root.input)?.operation !== "create_world" || obj(root.input)?.previousRequestId !== prior.recovery.sourceRequestId ||
      typeof obj(root.input)?.text !== "string" || createHash("sha256").update(obj(root.input)!.text).digest("hex") !== prior.identity.textHash) refuse();
  await visit(root, 0);
  const worlds = runs.filter(r => r.flow.id === "veya/veya-world-agent" && r.parent?.runId === root.id);
  if (worlds.length !== 1) refuse(); const world = worlds[0]!, wi = obj(world.input)!, resume = obj(obj(world.output)?.resume), original = obj(prior.recovery.resume)!;
  if (!resume || !same(obj(root.output)?.result, world.output) || !same(wi.resume, { ...original, round: prior.recovery.nextRound }) ||
      !same(wi.brief, prior.recovery.brief) || !same(obj(root.output)?.brief, wi.brief) || wi.outputMode !== "artifact" || !same(wi.continuation ?? [], []) ||
      !Number.isInteger(resume.round) || resume.round < prior.recovery.nextRound || resume.round > 3 ||
      !same(resume.plan, original.plan) || !same(resume.gameplay, original.gameplay) || resume.worldId !== original.worldId ||
      resume.generationScope !== original.generationScope || !same(resume.draft, original.draft)) refuse();
  for (const r of [root, world]) {
    const context = r.steps.filter(s => s.kind === "action" && s.actionId === "veya/creator-context"); const c = obj(context[0]?.output);
    if (context.length !== 1 || c?.creationId !== sourceRequestId || c?.homeWorldId !== prior.identity.homeWorldId ||
      !same(c?.worldProductionRecovery, prior.recovery) || c?.assetReuse || c?.worldDesignRecovery || c?.recovery || c?.productionMaterials) refuse();
  }
  const builds = runs.filter(r => r.flow.id === "veya/veya-world-build" && r.parent?.runId === world.id);
  if (!builds.length || !same(builds.at(-1)?.output, resume.build) || obj(builds.at(-1)?.input)?.repairRound !== resume.round ||
      builds.some(b => obj(b.input)?.draftId !== original.draft.draft_id || obj(b.input)?.generationScope !== original.generationScope || !same(obj(b.input)?.gameplaySpec, original.gameplay.spec))) refuse();
  const common = resume.build?.assets;
  if (common?.status !== "ready" || !same(common, original.build?.assets)) refuse();
  const props: any[] = resume.build?.props;
  if (!Array.isArray(props) || !props.length || new Set(props.map(p => p.spec?.id)).size !== props.length) refuse();
  const pins = new Map<string, string>(), modules: MaterialsGrant["proof"]["modules"] = [];
  const pin = (id: any, version: any) => { if (typeof id !== "string" || !hash.test(version) || pins.has(id) && pins.get(id) !== version) refuse(); pins.set(id, version); };
  const bindings = (list: any[]) => { if (!Array.isArray(list)) refuse(); for (const b of list) { pin(b.assetId, b.version); if (b.collisionAssetId) pin(b.collisionAssetId, b.collisionVersion); if (b.navigationAssetId) pin(b.navigationAssetId, b.navigationVersion); } };
  bindings(common.bindings);
  for (const p of props) {
    const producer = runs.find(r => r.flow.id === "veya/veya-prop-agent" && same(r.output, p));
    const prepare = producer && runs.find(r => r.flow.id === "veya/veya-prop-prepare" && r.parent?.runId === producer.id);
    const receipt = p.preparation, { receiptHash, ...body } = receipt ?? {};
    if (!producer || !prepare || p.status !== "ready" || !same(obj(producer.input)?.spec, p.spec) || !original.gameplay.spec.props.some((s: any) => same(s, p.spec)) ||
        productionDigest(p.spec) !== p.specHash || !same(obj(prepare.output)?.assets, p.assets) || !same(obj(prepare.output)?.preparation, receipt) ||
        receipt?.schemaVersion !== 1 || receipt.pipelineVersion !== "veya-prop-prepare-v2" || receiptHash !== materialIdentity(body) ||
        receipt.parametersHash !== materialIdentity({ dimensions: p.spec.dimensions, pivot: p.spec.pivot, motionEnvelope: p.spec.motionEnvelope, display: p.spec.display }) ||
        receipt.requirementsHash !== materialIdentity(p.spec.assets) || !same(receipt.preparedBindings, p.assets.bindings) ||
        !same(receipt.sourceBindings, obj(prepare.input)?.assets?.bindings) || !same(obj(prepare.input)?.spec, p.spec)) refuse();
    const store = producer.steps.find(s => s.kind === "action" && s.actionId === "veya/creation-module-write");
    if (!store || store.kind !== "action" || obj(store.output)?.module_id !== p.module?.module_id || obj(store.output)?.content_hash !== p.module?.content_hash || obj(store.input)?.module?.kind !== "prop") refuse();
    bindings(receipt.sourceBindings); bindings(receipt.preparedBindings);
    const cook = prepare.steps.find(s => s.kind === "action" && s.actionId === "veya/cooker-submit" &&
      materialIdentity(obj(s.input)?.pipelineSource) === receipt.pipelineHash);
    if (!cook || cook.kind !== "action") refuse();
    const submittedSources = obj(cook.input)?.sources;
    if (!Array.isArray(submittedSources) || !Array.isArray(receipt.recipeHashes) || receipt.recipeHashes.some((recipe: any) =>
      !submittedSources.some((source: any) => materialIdentity(source.source) === recipe.visual) ||
      !submittedSources.some((source: any) => materialIdentity(source.source) === recipe.collision))) refuse();
    const cooked = prepare.steps.find(s => s.kind === "action" && s.actionId === "veya/cooker-status" &&
      obj(s.input)?.operationId === obj(cook.output)?.operation_id && obj(s.output)?.status === "succeeded");
    const registered = obj(cooked?.output)?.assets;
    if (!Array.isArray(registered) || receipt.preparedBindings.some((binding: any) =>
      !registered.some((a: any) => a.id === binding.assetId && a.content_hash === binding.version) ||
      !registered.some((a: any) => a.id === binding.collisionAssetId && a.content_hash === binding.collisionVersion))) refuse();
    for (const a of obj(store.input)?.module?.assets ?? []) pin(a.asset_id, a.content_hash);
    modules.push({ moduleId: p.module.module_id, contentHash: p.module.content_hash });
  }
  let environmentResource: MaterialsGrant["materials"]["environmentResource"];
  const env = resume.build?.environment;
  if (env?.atmosphere) {
    const producer = runs.find(r => r.flow.id === "veya/veya-environment-lighting" && same(r.output, env));
    const held = obj(env.environmentResource), effective = held?.effectiveRequest ?? original.plan.atmosphere;
    const requestControls = (input: unknown) => {
      const fields = { ...obj(input) }; delete fields.expectedSources; delete fields.expected_sources; return fields;
    };
    const submit = producer?.steps.find(s => s.kind === "action" && s.actionId === "veya/atmosphere-build" && same(requestControls(s.input), effective));
    const done = producer?.steps.find(s => s.kind === "action" && s.actionId === "veya/cooker-status" && obj(s.input)?.operationId === obj(submit?.output)?.operation_id);
    const receipt = obj(submit?.output)?.status === "succeeded" ? obj(submit?.output) : obj(done?.output);
    const a = env.atmosphere;
    if (!producer || !submit || submit.kind !== "action" || !receipt || !same(obj(producer.input)?.plan?.atmosphere, original.plan.atmosphere) ||
        !same(obj(producer.input)?.plan?.lookIntent, original.plan.lookIntent) || !same(requestControls(submit.input), effective) ||
        (held && (!same(held.request, original.plan.atmosphere) || held.lookDescription !== original.plan.lookIntent.description || !same(held.atmosphere, a))) ||
        receipt.status !== "succeeded" || !hash.test(a.contentHash) || a.presetId !== original.plan.atmosphere.presetId || a.seed !== original.plan.atmosphere.seed) refuse();
    const nativeAssets = receipt.assets;
    const native = Array.isArray(nativeAssets) && nativeAssets.length === 1 ? nativeAssets[0] : undefined;
    if (!native || native.id !== a.assetId || native.content_hash !== a.contentHash || native.type !== "environment" ||
        native.atmosphere?.preset_id !== a.presetId || !same(native.atmosphere?.sun, a.sun) || native.path !== a.path || a.cloudSource !== original.plan.atmosphere.source) refuse();
    for (const p of environmentShaderPins(a)) if (!matchesEnvironmentShader(p, native)) refuse();
    pin(a.assetId, a.contentHash);
    environmentResource = { request: original.plan.atmosphere, lookDescription: original.plan.lookIntent.description, atmosphere: a,
      ...(held?.effectiveRequest ? { effectiveRequest: held.effectiveRequest } : {}) };
  }
  const catalogs = runs.flatMap(r => r.steps.filter(s => s.kind === "action" && s.actionId === "veya/asset-list").map(s => obj(s.output)));
  for (const [id, version] of pins) if (!catalogs.some(c => c?.[id]?.content_hash === version) && !prior.proof.assets.some(a => a.assetId === id && a.contentHash === version)) refuse();
  for (const p of environmentShaderPins(environmentResource)) if (!catalogs.some(c => matchesEnvironmentShader(p, c?.[p.assetId]))) refuse();
  return validateMaterialsGrant({ version: 1, identity: { ...prior.identity, requestTextHash: createHash("sha256").update(newText).digest("hex") },
    materials: { schemaVersion: 1, sourceRequestId, sourceRunId: root.id, sourceBrief: prior.recovery.brief,
      sourcePlan: original.plan, sourceGameplaySpec: original.gameplay.spec, sourceExhaustedRound: resume.round,
      validation: "unverified", noNewPaidWork: true, common, props, ...(environmentResource ? { environmentResource } : {}) },
    proof: { assets: [...pins].map(([assetId, contentHash]) => ({ assetId, contentHash })), modules,
      completedOperations: [...new Map(operations.map(o => [o.operation + o.fingerprint, o])).values()] } });
}
