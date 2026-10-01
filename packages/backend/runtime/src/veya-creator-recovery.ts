import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { preparationReconciliation } from "./veya-creator-reconciliation.ts";
import { reusedVerificationRuns } from "./veya-creator-reuse-verification.ts";

export type PropRecovery = { schemaVersion: 1; sourceRequestId: string; sourceRunId: string; noNewPaidWork: true;
  brief: JsonValue; propSpec: JsonValue; assets: JsonValue; preparation?: JsonValue; preparedOperation?: JsonValue; retainedProp?: JsonValue; preparationDefects?: JsonValue[];
  generationScope: string; repairRound: number; plan: JsonValue };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const hash = /^[a-f0-9]{64}$/u;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(object(value)!).sort().map(key => [key, canonical(object(value)![key])])) : value;
const stableDigest = (value: unknown) => digest(canonical(value));
const resourcePath = (value: unknown) => typeof value === "string" && /^res:\/\/assets\/[A-Za-z0-9_./-]+$/u.test(value) &&
  !value.slice(6).split("/").some(part => !part || part === "." || part === "..");
const recipePath = (value: unknown) => typeof value === "string" && /^content\/scripts\/cooker\/[A-Za-z0-9_./-]+\.luau$/u.test(value) &&
  !value.split("/").some(part => !part || part === "." || part === "..");

/** Extract validated durable outputs, never caller-supplied recovery JSON. */
export async function retainedPropWork(root: FlowRun, sourceRequestId: string, budgetCreationId: string,
  projectRoot: string, get: (id: string) => Promise<FlowRun>, trustedPrior?: PropRecovery): Promise<PropRecovery> {
  function refuse(): never { throw new Error("previous_request_unavailable"); }
  if (!(root.status === "failed" || (root.status === "completed" && object(root.output)?.status === "blocked")) ||
      root.flow.id !== "veya/veya-wish" || root.requestId !== sourceRequestId) refuse();
  const runs: FlowRun[] = [];
  const visit = async (run: FlowRun, depth: number) => {
    if (runs.length >= 64 || depth > 8 || runs.some(item => item.id === run.id)) refuse();
    runs.push(run);
    for (const step of run.steps) if (step.kind === "flow" && step.childRunId) {
      const child = await get(step.childRunId);
      if (child.parent?.runId !== run.id || child.parent.stepKey !== step.stepKey) refuse();
      await visit(child, depth + 1);
    }
  };
  await visit(root, 0);
  for (const run of runs.filter(item => item.flow.id === "veya/veya-prop-prepare")) {
    const output = object(run.output), issues = Array.isArray(output?.issues) ? output.issues : [];
    if (issues.some(value => ["prop_cook_submission_failed", "prop_cook_pending"].includes(String(object(value)?.code)))) refuse();
    for (const cook of run.steps.filter(step => step.kind === "action" && ["cook", "cook-correct"].includes(step.id))) {
      if (!["completed", "failed"].includes(cook.status)) refuse();
      if (cook.status === "failed" && !/^Veya (invalid_lua_source|invalid_pipeline|invalid_cooker_input) \(HTTP 400\)/u.test(cook.error ?? "")) refuse();
      if (cook.kind === "action" && cook.status === "completed") {
        const queued = object(cook.output), suffix = cook.id === "cook-correct" ? "-correct" : "";
        const wait = run.steps.find(step => step.kind === "action" && step.id === "wait" + suffix);
        const done = wait?.kind === "action" ? object(wait.output) : undefined;
        if (queued?.status !== "succeeded" && (typeof queued?.operation_id !== "string" || wait?.status !== "completed" ||
            done?.operation_id !== queued.operation_id || !["failed", "cancelled", "succeeded"].includes(String(done?.status)))) refuse();
      }
    }
  }
  const specialist = runs.find(run => run.flow.id === "veya/veya-specialist-task");
  const brief = object(object(specialist?.input)?.brief);
  if (brief?.schemaVersion !== 1 || brief.operation !== "create_prop" || typeof brief.summary !== "string" ||
      !Array.isArray(brief.constraints) || !Array.isArray(brief.acceptance)) refuse();
  const latest = [...runs].reverse();
  const propRun = latest.find(run => run.flow.id === "veya/veya-prop-agent" && ["failed", "completed"].includes(run.status));
  const admittedModule = object(object(trustedPrior?.retainedProp)?.module);
  const moduleReuse = !propRun && trustedPrior?.noNewPaidWork === true && admittedModule && runs.some(run =>
    run.steps.some(step => step.kind === "action" && step.id === "recovery-prop-module" && step.actionId === "veya/creation-module-read" && step.status === "completed" &&
      object(step.input)?.moduleId === admittedModule.module_id && object(step.input)?.contentHash === admittedModule.content_hash &&
      object(step.output)?.module_id === admittedModule.module_id && object(step.output)?.content_hash === admittedModule.content_hash));
  if (moduleReuse) {
    if (!same(trustedPrior.brief, brief) || !runs.some(run => run.steps.some(step => step.kind === "action" &&
        step.actionId === "veya/creator-context" && step.status === "completed" && same(object(step.output)?.recovery, trustedPrior)))) refuse();
    const verifiedSubtree = reusedVerificationRuns(runs, admittedModule);
    const allowedFlows = new Set(["veya/veya-wish", "veya/veya-specialist-task", "veya/veya-world-build"]);
    const allowedActions = new Set(["veya/creator-context", "veya/system-context", "veya/asset-list", "veya/creation-module-read",
      "veya/world-copy", "veya/travel-enter", "veya/operation-status", "veya/world-read", "veya/draft-create", "veya/draft-read", "veya/draft-compose"]);
    for (const run of runs) {
      if (verifiedSubtree.has(run.id)) continue;
      if (!allowedFlows.has(run.flow.id) || !["completed", "failed"].includes(run.status)) refuse();
      for (const step of run.steps) {
        if (step.kind === "flow") { if (!step.childRunId || !["completed", "failed"].includes(step.status)) refuse(); continue; }
        if (step.kind !== "action" || !allowedActions.has(step.actionId)) refuse();
        if (step.actionId === "veya/draft-compose") {
          const modules = object(step.input)?.modules;
          if (!Array.isArray(modules) || modules.length !== 1 || object(modules[0])?.module_id !== admittedModule.module_id ||
              object(modules[0])?.content_hash !== admittedModule.content_hash) refuse();
        }
        if (step.status === "failed") {
          // A known native rejection proves this draft did not commit. Unknown
          // HTTP/timeout/JSON failures must not be converted into a fresh write.
          if (step.actionId !== "veya/draft-compose" || !/^Veya [a-z][a-z0-9_]{0,95} \(HTTP (400|409|422)\)\./u.test(step.error ?? "")) refuse();
        } else if (step.status !== "completed") refuse();
        const queued = object(step.output);
        if (typeof queued?.operation_id === "string" && !["succeeded", "failed", "cancelled"].includes(String(queued.status)) &&
            !runs.some(child => child.steps.some(done => done.kind === "action" && done.actionId === "veya/operation-status" &&
              done.status === "completed" && object(done.input)?.operationId === queued.operation_id &&
              object(done.output)?.operation_id === queued.operation_id && ["succeeded", "failed", "cancelled"].includes(String(object(done.output)?.status))))) refuse();
      }
    }
  }
  // A rejected read-only design correction may precede all production. Carry
  // only the host's admitted prior, never the rejected Agent output, through
  // this new link; the common ledger checks below still run on every retry.
  const designOnly = !propRun && !moduleReuse && trustedPrior?.noNewPaidWork === true;
  if (designOnly) {
    if (!same(trustedPrior.brief, brief) || root.status !== "completed" ||
        !runs.some(run => run.steps.some(step => step.kind === "action" &&
          step.actionId === "veya/creator-context" && same(object(step.output)?.recovery, trustedPrior)))) refuse();
    const allowedFlows = new Set(["veya/veya-wish", "veya/veya-specialist-task", "veya/veya-world-gameplay-design"]);
    const allowedReads = new Set(["veya/creator-context", "veya/system-context"]);
    for (const run of runs) {
      if (!allowedFlows.has(run.flow.id) || run.status !== "completed" || object(run.output)?.status !== "blocked") refuse();
      if (run.flow.id === "veya/veya-world-gameplay-design" &&
          (object(run.input)?.repairProp !== true || !same(object(run.input)?.previousProp, trustedPrior.propSpec))) refuse();
      for (const step of run.steps) {
        if (step.status !== "completed") refuse();
        if (step.kind === "action") { if (!allowedReads.has(step.actionId)) refuse(); }
        else if (step.kind === "agent") { if (!Array.isArray(step.actions) || step.actions.length) refuse(); }
        else if (step.kind === "flow") { if (!step.childRunId) refuse(); }
        else refuse();
      }
    }
  }
  const forwardingPrior = Boolean(designOnly || moduleReuse);
  const input = forwardingPrior ? { spec: trustedPrior!.propSpec, generationScope: trustedPrior!.generationScope,
    repairRound: trustedPrior!.repairRound, effectPlan: trustedPrior!.plan } : object(propRun?.input);
  const prop = object(input?.spec);
  const plan = object(input?.effectPlan);
  const design = latest.find(run => run.flow.id === "veya/veya-world-gameplay-design" && run.status === "completed" &&
    object(run.output)?.status === "ready" && JSON.stringify(object(run.output)?.prop) === JSON.stringify(prop));
  if (trustedPrior && !same(trustedPrior.brief, brief)) refuse();
  if (design && object(design.input)?.repairProp === true) {
    const designInput = object(design.input)!, designOutput = object(design.output)!, revision = object(designOutput.designRevision);
    const designPlan = object(designInput.plan), before = object(trustedPrior?.propSpec);
    if (!before || !prop || !same(designInput.previousProp, before) || designInput.task !== brief?.summary ||
        !same(designPlan?.constraints, brief?.constraints) || !same(designPlan?.acceptance, brief?.acceptance) ||
        designPlan?.minGeneratedModels !== (brief?.minGeneratedModels ?? 0) ||
        revision?.beforeHash !== digest(before) || revision.afterHash !== digest(prop) || designOutput.specHash !== digest(prop)) refuse();
    for (const field of ["schemaVersion", "id", "intent", "display", "dimensions", "pivot", "motionEnvelope", "entities", "groundAnchor", "effects", "assets", "acceptance"])
      if (!same(before[field], prop?.[field])) refuse();
    for (const original of Array.isArray(before.interactions) ? before.interactions : []) {
      const item = object(original);
      if (!["read", "talk"].includes(String(item?.action))) continue;
      if (!(Array.isArray(prop?.interactions) ? prop.interactions : []).some(value => {
        const next = object(value);
        return next?.targetId === item?.targetId && next?.feedback === item?.feedback && next?.action === "talk" &&
          Array.isArray(next.outcomes) && next.outcomes.some(value => { const fact = object(value); return fact?.kind === "dialogue" &&
            fact.id === item?.targetId && fact.field === "text" && fact.equals === item?.feedback; });
      })) refuse();
    }
  }
  // A recovery deliberately skips design. Its already admitted binding remains
  // the design proof; arbitrary root/Flow input is never accepted as that proof.
  const retainedDesign = trustedPrior?.schemaVersion === 1 && trustedPrior.noNewPaidWork === true &&
    JSON.stringify(trustedPrior.propSpec) === JSON.stringify(prop);
  if ((!design && !retainedDesign) || !prop || prop.schemaVersion !== 1 || typeof prop.id !== "string" ||
      !Array.isArray(prop.assets) || !Array.isArray(prop.interactions) || !Array.isArray(prop.tests) ||
      typeof input?.generationScope !== "string" || !hash.test(input.generationScope) ||
      !Number.isInteger(input.repairRound) || Number(input.repairRound) < 0 || Number(input.repairRound) > 3 ||
      !Array.isArray(plan?.acceptance) || !Array.isArray(plan.effects)) refuse();
  const assetRun = latest.find(run => run.parent?.runId === propRun?.id && run.flow.id === "veya/veya-world-assets" &&
    run.status === "completed" && object(run.output)?.status === "ready");
  let sourceAssets = object(forwardingPrior ? trustedPrior!.assets : assetRun?.output);
  // A host-attested preparation defect intentionally bypasses WorldAssets.
  // Admit only the exact previous raw sources and charges after its read-only
  // catalog check, never arbitrary assets from the new PropAgent input.
  if (!sourceAssets && propRun && trustedPrior?.preparationDefects?.length) {
    const priorReceipt = object(trustedPrior.preparation), priorAssets = object(trustedPrior.assets);
    const catalogStep = propRun.steps.find(step => step.kind === "action" && step.id === "preparation-source-catalog" &&
      step.actionId === "veya/asset-list" && step.status === "completed");
    const catalog = object(catalogStep?.kind === "action" ? catalogStep.output : undefined);
    if (!same(input?.previousAssets, priorAssets) || !same(input?.previousPreparation, priorReceipt) ||
        !same(input?.defects, trustedPrior.preparationDefects) || input?.assetPolicy !== "reuse-only" ||
        input?.generationScope !== trustedPrior.generationScope || input?.repairRound !== trustedPrior.repairRound + 1 ||
        !Array.isArray(priorReceipt?.sourceBindings) || !catalog ||
        !runs.some(run => run.steps.some(step => step.kind === "action" && step.actionId === "veya/creator-context" &&
          step.status === "completed" && same(object(step.output)?.recovery, trustedPrior)))) refuse();
    for (const value of priorReceipt!.sourceBindings as unknown[]) {
      const binding = object(value), registered = typeof binding?.assetId === "string" ? object(catalog[binding.assetId]) : undefined;
      if (!registered || registered.content_hash !== binding?.version || !resourcePath(registered.path)) refuse();
    }
    sourceAssets = { ...priorAssets, bindings: priorReceipt!.sourceBindings };
  }
  const preparedRun = latest.find(run => run.parent?.runId === propRun?.id && run.flow.id === "veya/veya-prop-prepare" &&
    run.status === "completed" && object(run.output)?.status === "ready");
  const preparedOutput = object(preparedRun?.output);
  const preparation = object(forwardingPrior ? trustedPrior!.preparation : preparedOutput?.preparation);
  if (preparedOutput && !preparation) refuse();
  let preparedOperation: JsonValue | undefined = forwardingPrior ? trustedPrior!.preparedOperation : undefined;
  // A successful native operation can precede failure to serialize the final
  // Flow result. Preserve matched durable inputs/results; never recook merely
  // because that JSON receipt is missing. The plugin must reconstruct only
  // metadata and verify the original submission before using these bytes.
  if (!forwardingPrior) {
    const held = latest.find(run => run.parent?.runId === propRun?.id && run.flow.id === "veya/veya-prop-prepare" &&
      run.steps.some(step => step.kind === "action" && ["wait", "wait-correct", "cook", "cook-correct"].includes(step.id) &&
        step.status === "completed" && object(step.output)?.status === "succeeded"));
    if (held) {
      const heldInput = object(held.input), catalogStep = held.steps.find(step => step.kind === "action" && step.id === "catalog");
      const catalog = object(catalogStep?.kind === "action" ? catalogStep.output : undefined);
      if (!same(heldInput?.spec, prop) || !same(heldInput?.assets, sourceAssets) || !catalog || catalogStep?.status !== "completed") refuse();
      const wait = [...held.steps].reverse().find(step => step.kind === "action" && ["wait", "wait-correct", "cook", "cook-correct"].includes(step.id) &&
        step.status === "completed" && object(step.output)?.status === "succeeded");
      if (wait?.kind !== "action") refuse();
      const suffix = wait!.id.endsWith("-correct") ? "-correct" : "";
      const cook = held.steps.find(step => step.kind === "action" && step.id === "cook" + suffix);
      const recipe = held.steps.find(step => step.kind === "agent" && step.id === "recipe" + suffix);
      if (cook?.kind !== "action" || recipe?.kind !== "agent" || cook.status !== "completed" || recipe.status !== "completed") refuse();
      const submitted = object(cook.input), queued = object(cook.output), done = object(wait.output), details = object(done?.cooker);
      if (typeof queued?.operation_id !== "string" || done?.operation_id !== queued.operation_id ||
          (wait.id.startsWith("wait") && object(wait.input)?.operationId !== queued.operation_id) || typeof queued.request_id !== "string" ||
          done.request_id !== queued.request_id || details?.ok !== true || !Array.isArray(details.steps) || !details.steps.length ||
          details.steps.some(value => object(value)?.ok !== true) || typeof submitted?.pipelineSource !== "string" ||
          !Array.isArray(submitted.sources) || !Array.isArray(submitted.inputs) || submitted.timeoutSeconds !== 300 || !Array.isArray(done.assets)) refuse();
      let authored: Record<string, unknown> | undefined;
      try { authored = object(JSON.parse(recipe.output ?? "")); } catch { refuse(); }
      if (!Array.isArray(authored?.recipes) || !authored.recipes.length || !Array.isArray(sourceAssets?.bindings) ||
          authored.recipes.length !== sourceAssets.bindings.length) refuse();
      const recipeSources: JsonValue[] = [], assetInputs: JsonValue[] = [], recipes: JsonValue[] = [];
      if (submitted.sources.length > 32 || submitted.inputs.length > 16 || submitted.pipelineSource.length > 65536) refuse();
      for (const value of submitted.sources) {
        const item = object(value);
        if (!recipePath(item?.path) || typeof item?.source !== "string" || item.source.length > 16384) refuse();
        recipeSources.push({ path: item!.path as string, source: item!.source as string });
      }
      for (const value of submitted.inputs) {
        const item = object(value);
        if (!resourcePath(item?.source) || typeof item?.destination !== "string" || !resourcePath("res://" + item.destination)) refuse();
        assetInputs.push({ source: item!.source as string, destination: item!.destination as string });
      }
      for (const value of authored.recipes) {
        const item = object(value);
        if (typeof item?.requirementId !== "string" || typeof item.visual !== "string" || typeof item.collision !== "string" ||
            item.visual.length > 16384 || item.collision.length > 16384) refuse();
        recipes.push({ requirementId: item.requirementId as string, visual: item.visual as string, collision: item.collision as string });
      }
      const scopedCatalog: Record<string, JsonValue> = {};
      for (const value of sourceAssets.bindings) {
        const binding = object(value), asset = typeof binding?.assetId === "string" ? object(catalog[binding.assetId]) : undefined;
        if (!asset || asset.content_hash !== binding!.version || !resourcePath(asset.path) || typeof asset.type !== "string") refuse();
        scopedCatalog[binding!.assetId as string] = { path: asset.path as string, content_hash: asset.content_hash as string, type: asset.type as string };
      }
      const nativeAssets: JsonValue[] = [];
      for (const value of done.assets) {
        const asset = object(value);
        if (typeof asset?.id !== "string" || typeof asset.source_asset_id !== "string" ||
            typeof asset.content_hash !== "string" || !hash.test(asset.content_hash) || typeof asset.type !== "string") refuse();
        nativeAssets.push({ id: asset.id as string, source_asset_id: asset.source_asset_id as string,
          content_hash: asset.content_hash as string, type: asset.type as string });
      }
      preparedOperation = { schemaVersion: 1, prepareRunId: held.id, operationId: queued.operation_id as string,
        requestId: queued.request_id as string, specHash: digest(heldInput!.spec), sourceBindings: sourceAssets.bindings as JsonValue,
        catalog: scopedCatalog, recipes,
        submission: { pipelineSource: submitted.pipelineSource as string, sources: recipeSources,
          inputs: assetInputs, timeoutSeconds: 300 }, assets: nativeAssets };
    }
  }
  let assets = sourceAssets;
  if (preparation) {
    const preparedAssets = object(forwardingPrior ? trustedPrior!.assets : preparedOutput?.assets);
    const { receiptHash, ...body } = preparation;
    const raw = preparation.sourceBindings, normalized = preparation.preparedBindings, recipes = preparation.recipeHashes;
    if (preparation.schemaVersion !== 1 || preparation.pipelineVersion !== "veya-prop-prepare-v2" ||
        Object.keys(preparation).some(key => !["schemaVersion", "pipelineVersion", "parametersHash", "requirementsHash",
          "sourceBindings", "preparedBindings", "recipeHashes", "pipelineHash", "receiptHash"].includes(key)) ||
        typeof receiptHash !== "string" || !hash.test(receiptHash) || receiptHash !== stableDigest(body) ||
        preparation.parametersHash !== stableDigest({ dimensions: prop.dimensions, pivot: prop.pivot, motionEnvelope: prop.motionEnvelope, display: prop.display }) ||
        preparation.requirementsHash !== stableDigest(prop.assets) || typeof preparation.pipelineHash !== "string" || !hash.test(preparation.pipelineHash) ||
        !Array.isArray(raw) || !raw.length || raw.length > 16 || !Array.isArray(normalized) || !Array.isArray(recipes) ||
        normalized.length !== raw.length || recipes.length !== raw.length ||
        !same(preparedAssets?.bindings, normalized) || !same(preparedAssets?.costs, sourceAssets?.costs) ||
        (!forwardingPrior && !same(raw, sourceAssets?.bindings) && !(same(normalized, sourceAssets?.bindings) &&
          same(object(preparedRun?.input)?.previousPreparation, preparation) && trustedPrior &&
          (same(trustedPrior.preparation, preparation) ||
            (same(object(trustedPrior.preparedOperation)?.sourceBindings, raw) &&
              object(trustedPrior.preparedOperation)?.specHash === digest(prop) && same(trustedPrior.assets, { ...sourceAssets, bindings: raw })))))) refuse();
    const ids = (raw as unknown[]).map(value => object(value)?.requirementId);
    if (ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length ||
        new Set((normalized as unknown[]).map(value => object(value)?.requirementId)).size !== ids.length ||
        new Set((recipes as unknown[]).map(value => object(value)?.requirementId)).size !== ids.length) refuse();
    for (const value of normalized as unknown[]) {
      const binding = object(value);
      if (!ids.includes(binding?.requirementId) || typeof binding?.collisionAssetId !== "string" ||
          typeof binding.collisionVersion !== "string" || !hash.test(binding.collisionVersion)) refuse();
    }
    for (const value of recipes as unknown[]) {
      const recipe = object(value);
      if (!ids.includes(recipe?.requirementId) || typeof recipe?.visual !== "string" || !hash.test(recipe.visual) ||
          typeof recipe.collision !== "string" || !hash.test(recipe.collision)) refuse();
    }
    assets = preparedAssets;
    // Keep the original successful submission fingerprint even after a later
    // Run has reconstructed its metadata receipt. Every linked recovery must
    // continue refusing that exact cook instead of forgetting its side effect.
    if (!preparedOperation && trustedPrior?.preparedOperation && same(trustedPrior.preparation, preparation) &&
        same(object(trustedPrior.preparedOperation)?.sourceBindings, raw) &&
        object(trustedPrior.preparedOperation)?.specHash === digest(prop)) preparedOperation = trustedPrior.preparedOperation;
  }
  const costs = object(assets?.costs);
  if (assets?.schemaVersion !== 2 || !Array.isArray(assets.bindings) || !assets.bindings.length ||
      costs?.status !== "incurred" || typeof costs.credits !== "number" || !Number.isFinite(costs.credits) ||
      !Array.isArray(costs.records) || !costs.records.length || !Array.isArray(assets.retainedArtifacts) || assets.retainedArtifacts.length) refuse();
  const bindings = assets!.bindings as unknown[];
  if (!preparation && bindings.some(value => object(value)?.collisionAssetId || object(value)?.navigationAssetId)) refuse();
  for (const value of bindings) {
    const item = object(value);
    if (typeof item?.requirementId !== "string" || typeof item.assetId !== "string" ||
        typeof item.version !== "string" || !hash.test(item.version) ||
        (item.source === "generated" && (typeof item.artifactId !== "string" || !hash.test(item.artifactId)))) refuse();
  }
  const bytes = await readFile(join(projectRoot, ".aura", "world-agent-paid.json"));
  if (bytes.length > 2 * 1024 * 1024) refuse();
  const ledger = object(JSON.parse(bytes.toString("utf8"))), requests = object(ledger?.requests);
  if (ledger?.schemaVersion !== 1 || !requests) refuse();
  const known = new Map<string, number>();
  for (const value of Object.values(requests!)) {
    const request = object(value), stages = object(request?.stages);
    if (!stages) refuse();
    for (const value of Object.values(stages!)) {
      const stage = object(value);
      if (typeof stage?.taskId !== "string" || stage.actualUnknown === true) refuse();
      if (request!.creationId === budgetCreationId) {
        if (stage.status !== "completed" || typeof stage.actual !== "number" || !Number.isFinite(stage.actual) || stage.actual < 0) refuse();
        known.set(stage.taskId as string, stage.actual as number);
      }
    }
  }
  let total = 0; const used = new Set<string>();
  for (const value of costs!.records as unknown[]) {
    const record = object(value), taskIds = object(record?.taskIds);
    if (!taskIds || !Object.keys(taskIds).length || !bindings.some(item => object(item)?.requirementId === record?.requirementId)) refuse();
    let subtotal = 0;
    for (const id of Object.values(taskIds!)) {
      if (typeof id !== "string" || used.has(id) || !known.has(id)) refuse();
      used.add(id as string); subtotal += known.get(id as string)!;
    }
    if (!used.size || record?.credits !== subtotal) refuse();
    total += subtotal;
  }
  if (total !== costs!.credits) refuse();
  let retainedProp: JsonValue | undefined = forwardingPrior ? trustedPrior!.retainedProp : undefined;
  const produced = object(propRun?.output);
  if (propRun?.status === "completed" && produced?.status === "ready") {
    const module = object(produced.module), effects = object(produced.effects);
    const write = propRun.steps.find(step => step.kind === "action" && step.actionId === "veya/creation-module-write" &&
      step.status === "completed" && object(step.output)?.module_id === module?.module_id);
    const written = write?.kind === "action" ? object(write.output) : undefined;
    const priorModule = object(object(trustedPrior?.retainedProp)?.module);
    const read = propRun.steps.find(step => step.kind === "action" && step.actionId === "veya/creation-module-read" &&
      step.status === "completed" && object(step.output)?.module_id === module?.module_id);
    const observed = read?.kind === "action" ? object(read.output) : undefined;
    if (module?.schema_version !== 1 || module.kind !== "prop" || typeof module.module_id !== "string" ||
        !hash.test(module.module_id) || module.content_hash !== module.module_id || produced.specHash !== digest(prop) ||
        !same(produced.spec, prop) || !same(produced.assets, assets) || !same(produced.preparation, preparation) ||
        effects?.status !== "ready" || !Array.isArray(effects.effects) || typeof produced.summary !== "string" ||
        produced.summary.length > 2000 ||
        !(written?.content_hash === module.content_hash && written.kind === "prop") &&
          !(same(priorModule, module) && observed?.content_hash === module.content_hash)) refuse();
    retainedProp = { status: "ready", module: { schema_version: 1, kind: "prop", module_id: module.module_id,
      content_hash: module.content_hash as string }, spec: prop as JsonValue, specHash: produced.specHash as string,
      assets: assets as JsonValue, ...(preparation ? { preparation: preparation as JsonValue } : {}),
      effects: effects as JsonValue, summary: produced.summary as string };
  }
  const recovery: PropRecovery = { schemaVersion: 1, sourceRequestId, sourceRunId: root.id, noNewPaidWork: true,
    brief: brief as JsonValue, propSpec: prop as JsonValue, assets: assets as JsonValue,
    ...(preparation ? { preparation: preparation as JsonValue } : {}),
    ...(preparedOperation ? { preparedOperation } : {}),
    ...(retainedProp ? { retainedProp } : {}),
    generationScope: input!.generationScope as string, repairRound: input!.repairRound as number, plan: plan as JsonValue };
  try {
    const preparationDefects = await preparationReconciliation(projectRoot, recovery, runs);
    if (preparationDefects) recovery.preparationDefects = preparationDefects;
  } catch { refuse(); }
  if (Buffer.byteLength(JSON.stringify(recovery)) > 128 * 1024) refuse();
  return recovery;
}
