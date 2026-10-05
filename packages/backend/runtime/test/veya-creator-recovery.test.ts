import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { VeyaCreatorService, createVeyaCreatorApp } from "../src/veya-creator-routes.ts";
import { retainedPropWork } from "../src/veya-creator-recovery.ts";
import { readCreatorBindingDocument } from "@aura/orchestration";

// Prior tests cover final artifacts, not an unexported paid asset held by a
// failed child Run. Reusing that work must preserve provenance and charges.
test("failed prop recovery requires owned durable typed results and known paid work", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-prop-recovery-"));
  try {
    const sourceRequest = randomUUID(), worker = join(root, "worker.json");
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "a".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49000/", token: "b".repeat(64) }));
    const brief = { schemaVersion: 1, operation: "create_prop", summary: "read plaque", constraints: [], acceptance: ["read"] };
    const prop = { schemaVersion: 1, id: "plaque", assets: [{ id: "model" }], interactions: [], tests: [] };
    const assets = { schemaVersion: 2, status: "ready", bindings: [{ requirementId: "model", assetId: "asset", version: "c".repeat(64),
      artifactId: "d".repeat(64), source: "generated" }], retainedArtifacts: [],
      costs: { status: "incurred", credits: 90, records: [{ requirementId: "model", credits: 90, taskIds: { model: "provider-task" } }] } };
    const make = (flow: string, status: string, input: unknown, output?: unknown) =>
      ({ id: randomUUID(), requestId: randomUUID(), flow: { id: flow }, status, input, output, steps: [] }) as unknown as FlowRun;
    const source = make("veya/veya-wish", "failed", { text: "original plaque" }); source.requestId = sourceRequest;
    const specialist = make("veya/veya-specialist-task", "failed", { brief });
    const design = make("veya/veya-world-gameplay-design", "completed", {}, { status: "ready", prop });
    const producer = make("veya/veya-prop-agent", "failed", { spec: prop, generationScope: "e".repeat(64), repairRound: 2, effectPlan: { effects: [], acceptance: [] } });
    const paid = make("veya/veya-world-assets", "completed", {}, assets);
    const link = (parent: FlowRun, child: FlowRun) => {
      const stepKey = `main/${child.id}`;
      child.parent = { runId: parent.id, stepKey };
      parent.steps.push({ kind: "flow", stepKey, childRunId: child.id } as never);
    };
    link(source, specialist); link(specialist, design); link(specialist, producer); link(producer, paid);
    const runs = new Map([source, specialist, design, producer, paid].map(run => [run.id, run]));
    const flow = { async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", service: true, available: true }] } as T;
      if (method === "get") return runs.get(params.id as string) as T;
      return { id: source.id, status: "failed" } as T;
    } };
    const service = new VeyaCreatorService(root, flow as never); await service.initialize();
    const token = await service.register("owner", "home", worker), app = createVeyaCreatorApp(service);
    const post = (value: unknown) => app.request("/tasks", { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
    const initial = { requestId: sourceRequest, operation: "create_prop", text: "original plaque" };
    assert.equal((await post(initial)).status, 202);
    await mkdir(join(root, ".aura"), { recursive: true });
    const ledger = { schemaVersion: 1, requests: { paid: { creationId: sourceRequest,
      stages: { model: { status: "completed", taskId: "provider-task", actual: 90, actualUnknown: false } } } } };
    const ledgerPath = join(root, ".aura", "world-agent-paid.json");
    await writeFile(ledgerPath, JSON.stringify(ledger));
    const chargedAssets = structuredClone(assets);
    Object.assign(assets,{schemaVersion:3,bindings:[{requirementId:"model",assetId:"shared:model/axe/axe.scn",version:"c".repeat(64),source:"catalog"}],costs:{status:"not_incurred",credits:0,records:[]}});
    await assert.rejects(retainedPropWork(source,sourceRequest,sourceRequest,root,async id=>runs.get(id)!),"catalog claims cannot hide an existing supplier stage");
    await writeFile(ledgerPath,JSON.stringify({schemaVersion:1,requests:{}}));
    assert.deepEqual((await retainedPropWork(source,sourceRequest,sourceRequest,root,async id=>runs.get(id)!)).assets,assets);
    assets.bindings[0].source="generated";
    await assert.rejects(retainedPropWork(source,sourceRequest,sourceRequest,root,async id=>runs.get(id)!),"zero-cost generated work still needs provenance");
    Object.assign(assets,chargedAssets);
    await writeFile(ledgerPath, JSON.stringify(ledger));
    const recoveryId = randomUUID(), request = { ...initial, requestId: recoveryId, previousRequestId: sourceRequest };
    assert.equal((await post({ ...request, text: "different work" })).status, 409);
    assert.equal((await post({ ...request, previousArtifactId: "f".repeat(64) })).status, 400);
    ledger.requests.paid.stages.model.actualUnknown = true;
    await writeFile(ledgerPath, JSON.stringify(ledger));
    assert.equal((await post(request)).status, 409);
    ledger.requests.paid.stages.model.actualUnknown = false;
    await writeFile(ledgerPath, JSON.stringify(ledger));
    assert.equal((await post(request)).status, 202);
    // Prop recovery is stored as a hash grant; decode it the way the service does.
    const raw = await readFile(join(service.directory, "bindings.json"));
    assert.ok(JSON.parse(raw.toString("utf8")).bindings[recoveryId].propRecoveryRef, "recovery data is not inlined");
    const stored = await readCreatorBindingDocument(root, raw) as any;
    assert.equal(stored.bindings[recoveryId].recoveryBudgetCreationId, sourceRequest);
    assert.deepEqual(stored.bindings[recoveryId].recovery, { schemaVersion: 1, sourceRequestId: sourceRequest, sourceRunId: source.id, noNewPaidWork: true,
      brief, propSpec: prop, assets, generationScope: "e".repeat(64), repairRound: 2, plan: { effects: [], acceptance: [] } });
    const designStep = specialist.steps.shift()!;
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!));
    const chained = await retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery);
    assert.equal(chained.repairRound, 2);
    assert.deepEqual(chained.assets, assets, "a related recovery keeps trusted design, paid references and charges");
    const normalizedAssets = { ...assets, bindings: assets.bindings.map(binding => ({ ...binding,
      assetId: "prepared-visual", version: "9".repeat(64), collisionAssetId: "prepared-collision", collisionVersion: "8".repeat(64) })) };
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
    const stableHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
    const preparationBody = { schemaVersion: 1, pipelineVersion: "veya-prop-prepare-v2", parametersHash: stableHash({}),
      requirementsHash: stableHash(prop.assets), sourceBindings: assets.bindings, preparedBindings: normalizedAssets.bindings,
      recipeHashes: [{ requirementId: "model", visual: "7".repeat(64), collision: "6".repeat(64) }], pipelineHash: "5".repeat(64) };
    const preparation = { ...preparationBody, receiptHash: stableHash(preparationBody) };
    const prepared = make("veya/veya-prop-prepare", "completed", {}, { status: "ready", assets: normalizedAssets, preparation });
    link(producer, prepared); runs.set(prepared.id, prepared);
    const preparedRecovery = await retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery);
    assert.deepEqual(preparedRecovery.assets, normalizedAssets, "completed collision/visual preparation is retained with original charges");
    assert.deepEqual(preparedRecovery.preparation, preparation, "the receipt comes from the same durable preparation output");
    const paidLink = producer.steps.shift()!, oldProducerInput = producer.input, oldPreparedOutput = prepared.output;
    const geometryDefect = { id: "geometry", code: "prop_preparation_geometry", owner: "prop", severity: "error", moduleId: "plaque", requirementId: "model" };
    const geometryPrior = { ...preparedRecovery, repairRound: 1, preparationDefects: [geometryDefect],
      preparedOperation: { sourceBindings: assets.bindings, specHash: createHash("sha256").update(JSON.stringify(prop)).digest("hex"), operationId: "old-cook" } };
    producer.input = { ...(producer.input as object), previousAssets: normalizedAssets, previousPreparation: preparation,
      assetPolicy: "reuse-only", defects: [geometryDefect] };
    const sourceCatalog = { id: "preparation-source-catalog", kind: "action", actionId: "veya/asset-list", status: "completed",
      output: { asset: { path: "res://content/shared/generated/model/raw/scene.scn", content_hash: "c".repeat(64) } } };
    producer.steps.push(sourceCatalog as never);
    source.steps.push({ kind: "action", actionId: "veya/creator-context", status: "completed", output: { recovery: geometryPrior } } as never);
    const correctedBody = { ...preparationBody, pipelineHash: "1".repeat(64) }, correctedReceipt = { ...correctedBody, receiptHash: stableHash(correctedBody) };
    prepared.output = { status: "ready", assets: normalizedAssets, preparation: correctedReceipt };
    const geometryRecovery = await retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, geometryPrior);
    assert.deepEqual(geometryRecovery.assets, normalizedAssets, "local geometry repair keeps original supplier charges without a WorldAssets child");
    assert.deepEqual(geometryRecovery.preparation, correctedReceipt);
    assert.equal(geometryRecovery.preparedOperation, undefined, "a corrected receipt must not inherit the old recipe operation proof");
    sourceCatalog.output.asset.content_hash = "0".repeat(64);
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, geometryPrior));
    sourceCatalog.output.asset.content_hash = "c".repeat(64);
    (producer.input as Record<string, unknown>).repairRound = 1;
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, geometryPrior));
    producer.input = oldProducerInput; prepared.output = oldPreparedOutput; source.steps.pop(); producer.steps.pop(); producer.steps.unshift(paidLink);
    const priorProducerStatus = producer.status, priorProducerOutput = producer.output;
    producer.status = "completed";
    const module = { schema_version: 1, kind: "prop", module_id: "a".repeat(64), content_hash: "a".repeat(64) };
    producer.output = { status: "ready", module, spec: prop, specHash: createHash("sha256").update(JSON.stringify(prop)).digest("hex"),
      assets: normalizedAssets, preparation, effects: { status: "ready", effects: [] }, summary: "ready module" };
    const moduleWrite = { kind: "action", actionId: "veya/creation-module-write", status: "completed", output: module };
    producer.steps.push(moduleWrite as never);
    const retained = await retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery);
    assert.deepEqual(retained.retainedProp, producer.output, "a ready prop survives a downstream compose failure, bound to its native module receipt");
    const reuseRoot = make("veya/veya-wish", "failed", {}), reuseRoute = make("veya/veya-specialist-task", "failed", { brief }),
      reuseBuild = make("veya/veya-world-build", "failed", {});
    reuseRoot.steps.push({ kind: "action", actionId: "veya/creator-context", status: "completed", output: { recovery: retained } } as never);
    link(reuseRoot, reuseRoute); link(reuseRoute, reuseBuild);
    reuseRoot.steps.at(-1)!.status = "failed"; reuseRoute.steps.at(-1)!.status = "failed";
    reuseRoute.steps.unshift({ kind: "action", id: "recovery-prop-module", actionId: "veya/creation-module-read", status: "completed",
      input: { moduleId: module.module_id, contentHash: module.content_hash }, output: module } as never);
    const rejectedCompose = { kind: "action", actionId: "veya/draft-compose", status: "failed", input: { modules: [module] },
      error: "Veya invalid_feedback_cue (HTTP 422)." };
    reuseBuild.steps.push(rejectedCompose as never);
    for (const run of [reuseRoot, reuseRoute, reuseBuild]) runs.set(run.id, run);
    const reusedModule = await retainedPropWork(reuseRoot, reuseRoot.requestId!, sourceRequest, root, async id => runs.get(id)!, retained);
    assert.deepEqual(reusedModule.retainedProp, retained.retainedProp, "a pure module recompose can retain the prior without a new PropAgent subtree");
    rejectedCompose.error = "Veya World Agent connection failed.";
    await assert.rejects(retainedPropWork(reuseRoot, reuseRoot.requestId!, sourceRequest, root, async id => runs.get(id)!, retained),
      "an unknown recompose result cannot be converted into a fresh write");
    rejectedCompose.error = "Veya invalid_feedback_cue (HTTP 422).";
    reuseBuild.steps.push({ kind: "action", actionId: "veya/model-generate", status: "completed", output: {} } as never);
    await assert.rejects(retainedPropWork(reuseRoot, reuseRoot.requestId!, sourceRequest, root, async id => runs.get(id)!, retained),
      "pure reuse forwarding rejects hidden paid or authored work");
    reuseBuild.steps.pop();
    const candidate = { draftId: "draft", draftRevision: 2, worldId: "owned", contentHash: "b".repeat(64) }, gameplaySpec = { mode: "prop" };
    reuseBuild.status = "completed"; reuseBuild.output = { status: "ready", candidate, gameplaySpec };
    reuseBuild.steps[0] = { ...rejectedCompose, status: "completed", output: { draft_id: "draft", draft_revision: 2,
      world_id: "owned", content_hash: candidate.contentHash } } as never;
    const verify = make("veya/veya-world-verify", "completed", { candidate, gameplaySpec }, { contentHash: candidate.contentHash });
    const baseline = make("veya/veya-verify-baseline", "completed", { candidate }, { playtest: "failed" });
    link(reuseRoute, verify); reuseRoute.steps.at(-1)!.status = "completed";
    link(verify, baseline); verify.steps.at(-1)!.status = "completed";
    baseline.steps.push(
      { id: "begin", kind: "action", actionId: "veya/playtest-begin", status: "completed",
        input: { draftId: "draft", candidateHash: candidate.contentHash }, output: { world_id: "test_fixture", playtest_id: "test_fixture", candidate_hash: candidate.contentHash } } as never,
      { id: "end", kind: "action", actionId: "veya/playtest-end", status: "completed", input: { playtestId: "test_fixture" }, output: { playtest: false } } as never);
    runs.set(verify.id, verify); runs.set(baseline.id, baseline);
    const afterVerification = await retainedPropWork(reuseRoot, reuseRoot.requestId!, sourceRequest, root, async id => runs.get(id)!, retained);
    assert.deepEqual(afterVerification.retainedProp, retained.retainedProp, "ended failed verification does not discard the immutable module or charge provenance");
    assert.equal(afterVerification.repairRound, retained.repairRound);
    (verify.input as Record<string, unknown>).candidate = { ...candidate, contentHash: "f".repeat(64) };
    await assert.rejects(retainedPropWork(reuseRoot, reuseRoot.requestId!, sourceRequest, root, async id => runs.get(id)!, retained),
      "a different candidate cannot borrow completed module verification ancestry");
    (moduleWrite.output as Record<string, unknown>).content_hash = "0".repeat(64);
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery),
      "an Agent ready label cannot admit an unregistered or mismatched module");
    module.content_hash = "a".repeat(64);
    producer.steps.pop(); producer.status = priorProducerStatus; producer.output = priorProducerOutput;
    const previousPreparedInput = prepared.input, previousPaidOutput = paid.output;
    prepared.input = { previousPreparation: preparation }; paid.output = normalizedAssets;
    const reused = await retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, preparedRecovery);
    assert.deepEqual(reused.preparation, preparation, "a later recovery may already carry prepared bindings without re-normalizing them");
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery),
      "prepared source bindings require an exact prior preparation proof");
    prepared.input = previousPreparedInput; paid.output = previousPaidOutput;
    const validReceiptHash = preparation.receiptHash; preparation.receiptHash = "0".repeat(64);
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery));
    preparation.receiptHash = validReceiptHash;
    (prepared.output as Record<string, unknown>).assets = assets;
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery),
      "a receipt must not be combined with bindings from another preparation result");
    producer.steps.pop(); runs.delete(prepared.id);
    const successfulCook = make("veya/veya-prop-prepare", "failed", { spec: prop, assets });
    const submitted = { pipelineSource: "return {}", sources: [] as Record<string, string>[], inputs: [] as Record<string, string>[], timeoutSeconds: 300 };
    successfulCook.steps.push(
      { id: "catalog", kind: "action", status: "completed", output: { asset: { path: "res://content/shared/generated/model/source/scene.scn", content_hash: "c".repeat(64), type: "model" } } } as never,
      { id: "recipe", kind: "agent", status: "completed", output: JSON.stringify({ recipes: [{ requirementId: "model", visual: "visual", collision: "collision" }] }) } as never,
      { id: "cook", kind: "action", status: "completed", input: submitted, output: { status: "queued", operation_id: "cook_known", request_id: "request_known" } } as never,
      { id: "wait", kind: "action", status: "completed", input: { operationId: "cook_known" }, output: {
        status: "succeeded", operation_id: "cook_known", request_id: "request_known", cooker: { ok: true, steps: [{ ok: true }] },
        assets: [{ id: "prepared", source_asset_id: "prepared_source", content_hash: "4".repeat(64), type: "model" }] } } as never);
    link(producer, successfulCook); runs.set(successfulCook.id, successfulCook);
    const recoveredCook = await retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery);
    const preparedWorld = "9".repeat(32);
    specialist.steps.push({id:"draft",kind:"action",actionId:"veya/draft-create",status:"completed",input:{worldId:preparedWorld},output:{world_id:preparedWorld,draft_id:"prepared-draft"}} as never,
      {id:"draft-budget-0",kind:"action",actionId:"veya/draft-read",status:"completed",input:{draftId:"prepared-draft"},output:{world_id:preparedWorld}} as never);
    assert.equal((await retainedPropWork(source,sourceRequest,sourceRequest,root,async id=>runs.get(id)!,stored.bindings[recoveryId].recovery)).assetWorldId,preparedWorld);
    specialist.steps.pop();specialist.steps.pop();
    assert.equal((recoveredCook.preparedOperation as Record<string, unknown>).operationId, "cook_known");
    assert.deepEqual((recoveredCook.preparedOperation as Record<string, unknown>).submission, submitted,
      "a failed final JSON return preserves native success and its exact submitted source instead of recooking");
    submitted.inputs.push({ source: "C:/private/worker/model.scn", destination: "assets/raw.scn" });
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery),
      "recovery proofs cannot carry host filesystem paths into Flow context");
    submitted.inputs.pop();
    const doneStep = successfulCook.steps.pop()!;
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery),
      "an accepted operation without its known terminal result cannot fall back to normal preparation");
    successfulCook.steps.push(doneStep);
    ((doneStep as unknown as { output: Record<string, unknown> }).output).operation_id = "another_operation";
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery));
    producer.steps.pop(); runs.delete(successfulCook.id);
    const rejected = make("veya/veya-wish", "completed", {}, { status: "blocked" });
    const rejectedSpecialist = make("veya/veya-specialist-task", "completed", { brief }, { status: "blocked" });
    const rejectedDesign = make("veya/veya-world-gameplay-design", "completed", { repairProp: true, previousProp: prop },
      { status: "blocked", prop: { ...prop, id: "untrusted-invalid-correction" } });
    const prior = stored.bindings[recoveryId].recovery;
    rejected.steps.push({ kind: "action", actionId: "veya/creator-context", status: "completed", output: { recovery: prior } } as never);
    link(rejected, rejectedSpecialist); link(rejectedSpecialist, rejectedDesign);
    rejected.steps.at(-1)!.status = "completed"; rejectedSpecialist.steps.at(-1)!.status = "completed";
    rejectedDesign.steps.push({ kind: "agent", status: "completed", actions: [] } as never);
    for (const run of [rejected, rejectedSpecialist, rejectedDesign]) runs.set(run.id, run);
    const forwarded = await retainedPropWork(rejected, rejected.requestId!, sourceRequest, root, async id => runs.get(id)!, prior);
    assert.deepEqual(forwarded.propSpec, prop, "a rejected correction cannot replace the admitted prior design");
    assert.equal(forwarded.sourceRunId, rejected.id, "the new safe link remains traceable");
    assert.deepEqual(forwarded.assets, assets);
    const hiddenWrite = make("veya/veya-world-gameplay-design", "completed", { repairProp: true, previousProp: prop }, { status: "blocked" });
    hiddenWrite.steps.push({ kind: "action", status: "completed", actionId: "veya/draft-create" } as never);
    link(rejectedDesign, hiddenWrite); rejectedDesign.steps.at(-1)!.status = "completed"; runs.set(hiddenWrite.id, hiddenWrite);
    await assert.rejects(retainedPropWork(rejected, rejected.requestId!, sourceRequest, root, async id => runs.get(id)!, prior),
      "writes hidden in grandchildren must not qualify as read-only design failure");
    rejectedDesign.steps.pop();
    (rejectedDesign.steps[0] as { actions: unknown[] }).actions = [{ id: "veya/model-generator" }];
    await assert.rejects(retainedPropWork(rejected, rejected.requestId!, sourceRequest, root, async id => runs.get(id)!, prior),
      "Agent capabilities that could produce unknown side effects are refused");
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!,
      { ...stored.bindings[recoveryId].recovery, propSpec: { ...prop, id: "another" } }));
    specialist.steps.unshift(designStep);
    const priorDesignInput = design.input, priorDesignOutput = design.output;
    const corrected = { ...prop, interactions: [{ id: "reading", action: "talk", targetId: "plaque" }] };
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    design.input = { repairProp: true, previousProp: prop, task: brief.summary,
      plan: { constraints: brief.constraints, acceptance: brief.acceptance, minGeneratedModels: 0 } };
    design.output = { status: "ready", prop: corrected, specHash: hash(corrected),
      designRevision: { beforeHash: hash(prop), afterHash: hash(corrected) } };
    (producer.input as Record<string, unknown>).spec = corrected;
    const correctedRecovery = await retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery);
    assert.deepEqual(correctedRecovery.propSpec, corrected, "recovery retains the validated new specification, never restores the old defect");
    ((design.input as Record<string, unknown>).plan as Record<string, unknown>).acceptance = ["weaker"];
    await assert.rejects(retainedPropWork(source, sourceRequest, sourceRequest, root, async id => runs.get(id)!, stored.bindings[recoveryId].recovery));
    design.input = priorDesignInput; design.output = priorDesignOutput; (producer.input as Record<string, unknown>).spec = prop;
    (producer.input as Record<string, unknown>).repairRound = 4;
    assert.equal((await post({ ...request, requestId: randomUUID() })).status, 409, "recovery cannot reset an exhausted repair budget");
    (producer.input as Record<string, unknown>).repairRound = 2;
    source.status = "completed"; source.output = { status: "blocked" };
    assert.equal((await post({ ...request, requestId: randomUUID() })).status, 202);
    const pending = make("veya/veya-prop-prepare", "completed", {}, { status: "blocked", issues: [{ code: "prop_cook_pending" }] });
    link(producer, pending); runs.set(pending.id, pending);
    assert.equal((await post({ ...request, requestId: randomUUID() })).status, 409, "unknown/running Cooker work must be reconciled first");
    producer.steps.pop(); runs.delete(pending.id);
    const otherWorker = join(root, "other-worker.json");
    await writeFile(otherWorker, JSON.stringify({ role: "creator-worker", creation_session_id: "f".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49001/", token: "b".repeat(64) }));
    const other = await service.register("other_owner", "other_home", otherWorker);
    assert.equal((await app.request("/tasks", { method: "POST", headers: { authorization: `Bearer ${other}`,
      "content-type": "application/json" }, body: JSON.stringify({ ...request, requestId: randomUUID() }) })).status, 409);
    source.output = { status: "ready" };
    assert.equal((await post({ ...request, requestId: randomUUID() })).status, 409);
  } finally { await rm(root, { recursive: true, force: true }); }
});
