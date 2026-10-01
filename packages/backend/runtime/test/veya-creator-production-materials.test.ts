import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { materialIdentity, materialSubmissionFingerprint, productionDigest, readMaterialsGrant, validateMaterialsBinding,
  verifyMaterialsWorker, writeMaterialsGrant, type ProductionGrant } from "@aura/orchestration";
import { retainedProductionMaterials } from "../src/veya-creator-production-materials.ts";
import { retainedWorldProduction } from "../src/veya-creator-world-production-recovery.ts";
import { createVeyaCreatorApp, VeyaCreatorService } from "../src/veya-creator-routes.ts";

// A source exhausted its content repair allowance. The old recovery tests must
// continue rejecting it while immutable, unverified material can be read by a
// distinct new task. No test imports the real acceptance project's credentials.
function fixture() {
  const id = () => randomUUID(), h = (c: string) => c.repeat(64), runs = new Map<string, FlowRun>();
  const make = (name: string, input: any, output: any, parent?: FlowRun) => {
    const r = { id: id(), requestId: id(), flow: { id: "veya/" + name }, input, output, status: "completed", steps: [] } as unknown as FlowRun;
    if (parent) { const stepKey = "main/" + name; r.parent = { runId: parent.id, stepKey }; parent.steps.push({ kind: "flow", id: name, stepKey, status: "completed", childRunId: r.id } as never); }
    runs.set(r.id, r); return r;
  };
  const act = (r: FlowRun, actionId: string, input: any, output: any) => {
    const s = { kind: "action", actionId, id: actionId, stepKey: actionId, status: "completed", input, output };
    r.steps.push(s as never); return s;
  };
  const spec = { id: "plaque", dimensions: [1.2, .8, .08], display: "tabletop", pivot: "bottom_center", motionEnvelope: [0, 0, 0], assets: [{ id: "raw", kind: "existing" }], effects: [] };
  const raw = { requirementId: "raw", assetId: "raw_model", version: h("b"), source: "catalog" };
  const prepared = { ...raw, assetId: "prepared_model", version: h("c"), collisionAssetId: "prepared_collision", collisionVersion: h("d") };
  const receiptBody = { schemaVersion: 1, pipelineVersion: "veya-prop-prepare-v2", parametersHash: materialIdentity({ dimensions: spec.dimensions, pivot: spec.pivot, motionEnvelope: spec.motionEnvelope, display: spec.display }),
    requirementsHash: materialIdentity(spec.assets), sourceBindings: [raw], preparedBindings: [prepared], recipeHashes: [{ requirementId: "raw", visual: materialIdentity("return visual"), collision: materialIdentity("return collision") }], pipelineHash: materialIdentity("return {steps={}}") };
  const receipt = { ...receiptBody, receiptHash: materialIdentity(receiptBody) };
  const assets = { status: "ready", bindings: [prepared], costs: { status: "not_incurred", credits: 0 } };
  const prop = { status: "ready", spec, specHash: productionDigest(spec), module: { schema_version: 1, kind: "prop", module_id: h("f"), content_hash: h("f") }, assets, preparation: receipt, effects: {}, summary: "reading plaque" };
  const common = { status: "ready", bindings: [{ requirementId: "floor", assetId: "floor", version: h("a") }], costs: { status: "not_incurred", credits: 0 } };
  const text = "create a reading courtyard", brief = { operation: "create_world", sourceText: text }, plan = { requirements: brief, assets: [{ id: "floor" }] };
  const gameplay = { status: "ready", spec: { props: [spec], assets: [] }, specHash: "" }; gameplay.specHash = productionDigest(gameplay.spec);
  const draft = { draft_id: "1".repeat(32), world_id: "2".repeat(32), draft_revision: 1, base_revision: 1, content_hash: h("3") };
  const original = { plan, gameplay, worldId: draft.world_id, draft, generationScope: h("4"), build: { assets: common }, round: 0 };
  const prior: ProductionGrant = { version: 1, identity: { playerId: "player", homeWorldId: "home", creationSessionId: "5".repeat(32), textHash: createHash("sha256").update(text).digest("hex") },
    recovery: { schemaVersion: 1, sourceRequestId: id(), sourceRunId: id(), brief, continuation: [], resume: original, resumeHash: productionDigest(original), noNewPaidWork: true, nextRound: 1 },
    proof: { world: { worldId: draft.world_id, ownerId: "6".repeat(32), revision: 1, contentHash: h("7") }, draft,
      assets: [{ assetId: "floor", contentHash: h("a") }], modules: [], completedOperations: [{ operationId: "cook_common", fingerprint: h("8") }] } };
  const built = { status: "blocked", assets: common, props: [prop] }, resume = { ...original, build: built, round: 3 };
  const wo = { status: "needs_attention", resume };
  const root = make("veya-wish", { operation: "create_world", previousRequestId: prior.recovery.sourceRequestId, text }, { status: "blocked", brief, result: wo });
  const world = make("veya-world-agent", { resume: { ...original, round: 1 }, brief, outputMode: "artifact", continuation: [] }, wo, root);
  const context = { creationId: root.requestId, homeWorldId: "home", worldProductionRecovery: prior.recovery };
  act(root, "veya/creator-context", {}, context); act(world, "veya/creator-context", {}, context);
  const build = make("veya-world-build", { draftId: draft.draft_id, generationScope: original.generationScope, gameplaySpec: gameplay.spec, repairRound: 3 }, built, world);
  act(build, "veya/asset-list", {}, { floor: { content_hash: h("a") }, raw_model: { content_hash: h("b") }, prepared_model: { content_hash: h("c") }, prepared_collision: { content_hash: h("d") } });
  const producer = make("veya-prop-agent", { spec }, prop, build);
  const prepare = make("veya-prop-prepare", { spec, assets: { bindings: [raw] } }, { status: "ready", assets, preparation: receipt }, producer);
  act(prepare, "veya/cooker-submit", { pipelineSource: "return {steps={}}", sources: [{ source: "return visual" }, { source: "return collision" }], inputs: [] }, { operation_id: "cook_prop", status: "queued" });
  act(prepare, "veya/cooker-status", { operationId: "cook_prop" }, { operation_id: "cook_prop", status: "succeeded", cooker: { ok: true, steps: [{ ok: true, error: 0 }] },
    assets: [{ id: prepared.assetId, content_hash: prepared.version }, { id: prepared.collisionAssetId, content_hash: prepared.collisionVersion }] });
  act(producer, "veya/creation-module-write", { module: { kind: "prop", assets: [{ asset_id: "prepared_model", content_hash: h("c") }, { asset_id: "prepared_collision", content_hash: h("d") }] } }, prop.module);
  const get = async (key: string) => { const r = runs.get(key); assert.ok(r); return r; };
  return { root, world, build, producer, prepare, prop, prior, runs, make, act, get, text, resume, admit: () => retainedProductionMaterials(root, root.requestId, get, prior) };
}
test("exhausted world exposes only immutable material, never a new recovery round", async () => {
  const f = fixture(), grant = await f.admit();
  assert.equal(grant.materials.sourceExhaustedRound, 3); assert.equal(grant.materials.validation, "unverified");
  assert.equal(grant.materials.noNewPaidWork, true); assert.deepEqual(grant.materials.props, [f.prop]);
  for (const key of ["resume", "worldId", "draft", "nextRound", "layout", "environment", "modules"]) assert.equal(key in grant.materials, false);
  await assert.rejects(() => retainedWorldProduction(f.root, f.root.requestId, f.get, f.prior.identity, { production: f.prior }));
});
test("materials reject hidden side effects, incomplete trees, changed design, recipe and pins", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => f.act(f.prepare, "veya/model-generate", {}, {}),
    (f: ReturnType<typeof fixture>) => f.act(f.prepare, "veya/world-apply", {}, {}),
    (f: ReturnType<typeof fixture>) => f.act(f.world, "veya/travel-enter", { worldId: "foreign" }, {}),
    (f: ReturnType<typeof fixture>) => f.make("veya-world-plan", {}, {}, f.world),
    (f: ReturnType<typeof fixture>) => { f.prepare.status = "running"; },
    (f: ReturnType<typeof fixture>) => { f.prepare.parent!.runId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.prop.preparation.receiptHash = "9".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.prop.specHash = "9".repeat(64); },
    (f: ReturnType<typeof fixture>) => { (f.build.steps[0]!.output as any).prepared_model.content_hash = "9".repeat(64); },
    (f: ReturnType<typeof fixture>) => { (f.prepare.steps[1]!.output as any).status = "running"; },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[1] as any).output.content_hash = "9".repeat(64); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(f.admit); }
});
test("materials are immutable bounded refs and same owner/session/budget reference", async t => {
  const f = fixture(), grant = await f.admit(), dir = await mkdtemp(join(tmpdir(), "aura-materials-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const ref = await writeMaterialsGrant(dir, grant); assert.deepEqual(await readMaterialsGrant(dir, ref), grant);
  assert.deepEqual(await writeMaterialsGrant(dir, grant), ref);
  const source = { ...f.prior.identity, runId: f.root.id, input: { operation: "create_world", text: f.text }, sessionPath: "same", recoveryBudgetCreationId: f.prior.recovery.sourceRequestId };
  const binding = { ...source, runId: randomUUID(), productionMaterialsRef: ref, input: { ...source.input, reuseProductionFromRequestId: f.root.requestId } };
  validateMaterialsBinding(grant, binding, source);
  for (const patch of [{ playerId: "other" }, { creationSessionId: "9".repeat(32) }, { recoveryBudgetCreationId: randomUUID() }, { worldDesignRecovery: {} }])
    assert.throws(() => validateMaterialsBinding(grant, { ...binding, ...patch }, source));
  const newText = f.text + ". This is a distinct new work with the same material specifications.";
  const fresh = await retainedProductionMaterials(f.root, f.root.requestId, f.get, f.prior, newText);
  const newBinding = { ...binding, input: { ...binding.input, text: newText } };
  validateMaterialsBinding(fresh, newBinding, source);
  assert.equal(fresh.identity.textHash, grant.identity.textHash);
  assert.notEqual(fresh.identity.requestTextHash, grant.identity.requestTextHash);
  assert.throws(() => validateMaterialsBinding(fresh, binding, source));
  assert.throws(() => validateMaterialsBinding(fresh, newBinding, { ...source, input: { ...source.input, text: newText } }));
  const path = join(dir, ".aura", "veya-creator", "materials", ref.grantId + ".json");
  await writeFile(path, (await readFile(path, "utf8")) + " "); await assert.rejects(() => readMaterialsGrant(dir, ref));
});
test("live material admission reads resources and prop modules without world or draft writes", async () => {
  const f = fixture(), g = await f.admit(), calls: string[] = [];
  const call = async (op: string): Promise<any> => { calls.push(op);
    if (op === "veya.world.status") return { profile: { home_world_id: "home" } };
    if (op === "veya.assets.list") return Object.fromEntries(g.proof.assets.map(a => [a.assetId, { content_hash: a.contentHash }]));
    if (op === "veya.creation.module.read") return f.prop.module;
    throw Error("unexpected"); };
  await verifyMaterialsWorker(g, call); assert.deepEqual(calls, ["veya.world.status", "veya.assets.list", "veya.creation.module.read"]);
  await assert.rejects(() => verifyMaterialsWorker(g, async op => op === "veya.assets.list" ? {} : call(op)));
  assert.equal(materialSubmissionFingerprint("veya.cooker.submit", { pipelineSource: "return {}", requestId: "old", timeoutSeconds: 300 }),
    materialSubmissionFingerprint("veya.cooker.submit", { pipeline_source: "return {}", request_id: "new", timeout_seconds: 30 }));
  assert.equal(materialSubmissionFingerprint("veya.atmosphere.build", { presetId: "blue_hour", seed: 1, source: "procedural", cloudAmount: 0, cloudScale: 1, haze: 0, warmth: 0, brightness: 0 }),
    materialSubmissionFingerprint("veya.atmosphere.build", { preset_id: "blue_hour", seed: 1, source: "procedural", cloud_amount: 0, cloud_scale: 1, haze: 0, warmth: 0, brightness: 0, request_id: "new" }));
});

test("environment material proves effective controls against its completed native submission", async () => {
  function environmentFixture(shader = false) {
    const f = fixture(), plan = (f.prior.recovery.resume as any).plan;
    const request = { presetId: "blue_hour", seed: 42, source: "procedural", haze: .1 };
    const effectiveRequest = { ...request, haze: .2 };
    plan.atmosphere = request; plan.lookIntent = { description: "twilight" };
    f.prior.recovery.resumeHash = productionDigest(f.prior.recovery.resume);
    const atmosphere = { assetId: "sky", path: "res://assets/generated/sky.res", contentHash: "9".repeat(64), presetId: request.presetId,
      seed: 42, cloudSource: "procedural", sun: { direction: [0, -1, 0], color: [1, 1, 1], energy: 1 }, ...(shader ? { shaderHash: "a".repeat(64) } : {}) };
    const held = { request, effectiveRequest, lookDescription: "twilight", atmosphere };
    const env = { status: "ready", atmosphere, environmentResource: held };
    (f.build.output as any).environment = env;
    const producer = f.make("veya-environment-lighting", { plan }, env, f.build);
    f.act(producer, "veya/atmosphere-build", { ...effectiveRequest, ...(shader ? { expectedSources: { schemaVersion: 1,
      shaderSha256: atmosphere.shaderHash, recipeSha256: "b".repeat(64), templateSha256: "c".repeat(64) } } : {}) }, { operation_id: "cook_sky", status: "queued" });
    f.act(producer, "veya/cooker-status", { operationId: "cook_sky" }, { operation_id: "cook_sky", status: "succeeded", cooker: { ok: true, steps: [{ ok: true, error: 0 }] },
      assets: [{ id: "sky", path: atmosphere.path, content_hash: atmosphere.contentHash, type: "environment", atmosphere: { preset_id: request.presetId, sun: atmosphere.sun,
        ...(shader ? { shader_sha256: atmosphere.shaderHash } : {}) } }] });
    (f.build.steps[0]!.output as any).sky = { content_hash: atmosphere.contentHash,
      ...(shader ? { type: "environment", atmosphere: { shader_sha256: atmosphere.shaderHash } } : {}) };
    return { ...f, held, producer };
  }
  const f = environmentFixture(), g = await f.admit();
  assert.deepEqual(g.materials.environmentResource, f.held);
  assert.equal(g.proof.completedOperations.at(-1)?.operation, "veya.atmosphere.build");
  for (const mutate of [
    (x: ReturnType<typeof environmentFixture>) => { x.held.effectiveRequest.seed++; },
    (x: ReturnType<typeof environmentFixture>) => { x.held.effectiveRequest.haze = 2; },
    (x: ReturnType<typeof environmentFixture>) => { x.held.atmosphere.path = "C:/private/sky.res"; },
    (x: ReturnType<typeof environmentFixture>) => { (x.producer.steps[1]!.output as any).assets[0].content_hash = "8".repeat(64); },
    (x: ReturnType<typeof environmentFixture>) => { x.held.lookDescription = "different"; },
  ]) { const x = environmentFixture(); mutate(x); await assert.rejects(x.admit); }
  const upgraded = environmentFixture(true), upgradedGrant = await upgraded.admit();
  assert.equal((upgradedGrant.materials.environmentResource!.atmosphere as any).shaderHash, "a".repeat(64));
  const call = async (op: string): Promise<any> => op === "veya.world.status" ? { profile: { home_world_id: "home" } }
    : op === "veya.assets.list" ? upgraded.build.steps[0]!.output : upgraded.prop.module;
  await verifyMaterialsWorker(upgradedGrant, call);
  (upgraded.build.steps[0]!.output as any).sky.atmosphere.shader_sha256 = "b".repeat(64);
  await assert.rejects(() => verifyMaterialsWorker(upgradedGrant, call), /production_materials_state_changed/);
  await assert.rejects(upgraded.admit, /production_materials_unavailable/);
  const forged = environmentFixture(true); (forged.held.atmosphere as any).shaderHash = "f".repeat(64);
  await assert.rejects(forged.admit, /production_materials_unavailable/);
  const unknown = environmentFixture(true); (unknown.held.atmosphere as any).templateHash = "a".repeat(64);
  await assert.rejects(unknown.admit, /production_materials_invalid/);
});

test("material source references cannot be mixed with recovery, artifact or client-supplied proof", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aura-material-http-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const worker = join(dir, "worker.json");
  await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "a".repeat(32), protocol: "veya-world-http/1",
    base_url: "http://127.0.0.1:49990/", token: "b".repeat(64) }));
  let starts = 0;
  const service = new VeyaCreatorService(dir, { async request<T>(method: string): Promise<T> {
    if (method === "start") starts++;
    return { flows: [{ id: "veya/veya-wish", available: true, service: true }] } as T;
  } }, "c".repeat(64));
  await service.initialize(); const app = createVeyaCreatorApp(service);
  const post = (body: unknown, token: string) => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const connected = await app.request("/clients", post({ playerId: "player", homeWorldId: "home", workerSessionPath: worker }, service.bootstrapToken));
  assert.equal(connected.status, 201); const token = (await connected.json() as any).token;
  const base = { requestId: randomUUID(), operation: "create_world", text: "new courtyard", reuseProductionFromRequestId: randomUUID() };
  for (const patch of [{ previousRequestId: randomUUID() }, { previousArtifactId: "d".repeat(64) },
    { reuseAssetsFromRequestId: randomUUID() }, { references: [] }, { operation: "create_prop" }, { productionMaterials: {} }]) {
    const response = await app.request("/tasks", post({ ...base, ...patch }, token));
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  const unknown = await app.request("/tasks", post(base, token));
  assert.equal(unknown.status, 409); assert.deepEqual(await unknown.json(), { error: "production_materials_unavailable" });
  assert.equal(starts, 0);
});
