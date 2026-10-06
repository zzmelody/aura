import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { productionDigest, readProductionGrant, writeProductionGrant, validateProductionBinding, verifyProductionWorker, cookerSubmissionFingerprint, materialSubmissionFingerprint, type MaterialsGrant } from "@aura/orchestration";
import { retainedWorldProduction } from "../src/veya-creator-world-production-recovery.ts";
import { VeyaCreatorService } from "../src/veya-creator-routes.ts";

// Existing design recovery accepts only read-only syntax/review trees; it cannot
// prove an owned draft, completed production, or remaining repair allowance.
function fixture() {
  const runs = new Map<string, FlowRun>(), worldId = "a".repeat(32), owner = "b".repeat(32), home = "c".repeat(32), text = "make a reading courtyard";
  const make = (name: string, input: any, output: any, parent?: FlowRun) => {
    const run = { id: randomUUID(), requestId: randomUUID(), flow: { id: "veya/" + name }, input, output, status: "completed", steps: [] } as unknown as FlowRun;
    if (parent) { const stepKey = "main/" + name; run.parent = { runId: parent.id, stepKey };
      parent.steps.push({ id: name, kind: "flow", stepKey, status: "completed", childRunId: run.id } as never); }
    runs.set(run.id, run); return run;
  };
  const act = (run: FlowRun, id: string, actionId: string, input: any, output: any) =>
    run.steps.push({ id, stepKey: "main/" + id, kind: "action", actionId, status: "completed", input, output } as never);
  const brief = { schemaVersion: 1, operation: "create_world", sourceText: text, summary: text, constraints: [], acceptance: ["read"] };
  const plan = { requirements: brief, assets: [], operation: "copy", targetWorldId: "creation-template" };
  const spec = { props: [], assets: [] }, gameplay = { status: "ready", spec, specHash: productionDigest(spec) };
  const draft = { draft_id: "d".repeat(32), draft_revision: 1, world_id: worldId, base_revision: 1, content_hash: "e".repeat(64), assets: ["raw"], asset_versions: { raw: "f".repeat(64) } };
  const assets = { status: "ready", bindings: [{ assetId: "raw", version: "f".repeat(64) }], costs: { status: "not_incurred", credits: 0 } };
  const propOutput = { status: "blocked", assets, issues: [{ code: "recipe_required" }] };
  const built = { status: "blocked", assets, gameplaySpec: spec, props: [], modules: [], retainedProduction: { kind: "prop", id: "plaque", result: propOutput } };
  const resume = { plan, gameplay, source: { world_id: "creation-template" }, worldId, draft, build: built, round: 0, generationScope: "1".repeat(64) };
  const wo = { status: "needs_attention", resume };
  const root = make("veya-wish", { operation: "create_world", text, homeWorldId: home }, { status: "blocked", brief, result: wo });
  const world = make("veya-world-agent", { brief, outputMode: "artifact", continuation: [] }, wo, root);
  const context = { creationId: root.requestId, homeWorldId: home, operation: "create_world" };
  act(root, "context", "veya/creator-context", {}, context); act(world, "context", "veya/creator-context", {}, context);
  make("veya-world-plan", { brief }, plan, world);
  make("veya-world-gameplay-design", { plan: { ...plan, returnHome: { schemaVersion: 1, binding: "personal_home", entityId: "return_home", arrival: "home_return" } } }, gameplay, world);
  act(world, "draft", "veya/draft-create", { worldId }, draft);
  const build = make("veya-world-build", { repairRound: 0, draftId: draft.draft_id, generationScope: resume.generationScope,
    gameplaySpec: spec, plan: { ...plan, targetWorldId: worldId, returnHome: { schemaVersion: 1, binding: "personal_home", entityId: "return_home", arrival: "home_return" } } }, built, world);
  const snapshot = { revision: 1, content_hash: "2".repeat(64), manifest: { world_id: worldId, owner_id: owner, revision: 1 } };
  act(build, "source", "veya/world-read", { worldId }, snapshot);
  act(build, "catalog", "veya/asset-list", {}, { raw: { content_hash: "f".repeat(64) } });
  make("veya-world-assets", {}, assets, build);
  const prop = make("veya-prop-agent", {}, propOutput, build);
  const prepare = make("veya-prop-prepare", {}, propOutput, prop);
  const identity = { playerId: "player", homeWorldId: home, creationSessionId: "3".repeat(32), textHash: createHash("sha256").update(text).digest("hex") };
  const get = async (id: string) => { const run = runs.get(id); assert.ok(run); return run; };
  return { root, world, build, prepare, resume, identity, runs, get, make, act, snapshot, draft, text, home, owner,
    admit: () => retainedWorldProduction(root, root.requestId, get, identity, {}) };
}
test("production checkpoint preserves exact resume and consumes the next round", async () => {
  const f = fixture(), bytes = JSON.stringify(f.resume), grant = await f.admit();
  assert.equal(JSON.stringify(grant.recovery.resume), bytes); assert.equal(grant.recovery.resumeHash, productionDigest(f.resume));
  assert.equal(grant.recovery.nextRound, 1); assert.equal(grant.recovery.noNewPaidWork, true);
  assert.deepEqual(grant.proof.assets, [{ assetId: "raw", contentHash: "f".repeat(64) }]);
  assert.equal("worldDesignRecovery" in grant.recovery, false);
});

function materialFixture() {
  const f = fixture(), sourceId = randomUUID(), moduleId = "4".repeat(64);
  const spec = { id: "plaque", assets: [] }, prop = { status: "ready", module: { module_id: moduleId, content_hash: moduleId, kind: "prop" },
    spec, specHash: productionDigest(spec), preparation: { receiptHash: "5".repeat(64) }, assets: f.resume.build.assets };
  const gameplay: any = f.resume.gameplay; gameplay.spec.props = [spec]; gameplay.specHash = productionDigest(gameplay.spec);
  const built: any = f.resume.build; built.props = [prop]; delete built.retainedProduction;
  f.build.steps = f.build.steps.filter(s => s.kind !== "flow");
  const material: MaterialsGrant = { version: 1, identity: { ...f.identity, textHash: "6".repeat(64), requestTextHash: f.identity.textHash },
    materials: { schemaVersion: 1, sourceRequestId: sourceId, sourceRunId: randomUUID(), sourceBrief: f.world.input as never,
      sourcePlan: f.resume.plan, sourceGameplaySpec: gameplay.spec, sourceExhaustedRound: 3, validation: "unverified", noNewPaidWork: true,
      common: built.assets, props: [prop] }, proof: { assets: [{ assetId: "raw", contentHash: "f".repeat(64) }],
      modules: [{ moduleId, contentHash: moduleId }], completedOperations: [{ operation: "veya.atmosphere.build", operationId: "cook_old_env", fingerprint: "7".repeat(64) }] } };
  material.materials.sourceBrief = { operation: "create_world" };
  (f.root.input as any).reuseProductionFromRequestId = sourceId;
  (f.world.input as any).productionMaterials = material.materials;
  for (const r of [f.root, f.world]) (r.steps.find(s => s.id === "context")!.output as any).productionMaterials = material.materials;
  return { ...f, material, prop, admit: () => retainedWorldProduction(f.root, f.root.requestId, f.get, f.identity, { productionMaterials: material }) };
}

test("a fresh material task resumes its current round with exact host-proven cached modules", async () => {
  const f = materialFixture(), before = JSON.stringify(f.resume), grant = await f.admit();
  assert.equal(grant.recovery.nextRound, 1); assert.equal(JSON.stringify(grant.recovery.resume), before);
  assert.equal(f.material.materials.sourceExhaustedRound, 3, "old exhausted work is never reset");
  assert.deepEqual(grant.proof.modules, f.material.proof.modules);
  assert.deepEqual(grant.proof.completedOperations, f.material.proof.completedOperations);
  assert.equal("productionMaterials" in grant.recovery, false);
});

test("material result normalization admits only the shared schema's empty effect cost records", async () => {
  const f = materialFixture();
  (f.prop as any).effects = { costs: { status: "not_incurred", credits: 0 } };
  const cached = structuredClone(f.prop) as any; cached.effects.costs.records = [];
  (f.resume.build as any).props = [cached];
  await f.admit();
  cached.effects.costs.records.push({ invented: true }); await assert.rejects(f.admit);
});

test("material production recovery rejects untrusted caches, changed identity/specs and hidden work", async () => {
  const original = materialFixture();
  await assert.rejects(() => retainedWorldProduction(original.root, original.root.requestId, original.get, original.identity, {}));
  for (const mutate of [
    (f: ReturnType<typeof materialFixture>) => { f.material.identity.requestTextHash = "8".repeat(64); },
    (f: ReturnType<typeof materialFixture>) => { f.material.identity.creationSessionId = "8".repeat(32); },
    (f: ReturnType<typeof materialFixture>) => { (f.root.input as any).reuseProductionFromRequestId = randomUUID(); },
    (f: ReturnType<typeof materialFixture>) => { (f.world.input as any).productionMaterials = {}; },
    (f: ReturnType<typeof materialFixture>) => { (f.resume.build as any).assets = { ...f.resume.build.assets, bindings: [] }; },
    (f: ReturnType<typeof materialFixture>) => { (f.resume.gameplay.spec.props as any) = [{ id: "changed" }]; f.resume.gameplay.specHash = productionDigest(f.resume.gameplay.spec); },
    (f: ReturnType<typeof materialFixture>) => { (f.resume.build as any).props = [{ ...f.prop, module: { ...f.prop.module, module_id: "9".repeat(64) } }]; },
    (f: ReturnType<typeof materialFixture>) => { f.resume.round = 3; },
    (f: ReturnType<typeof materialFixture>) => { f.act(f.build, "paid", "veya/model-generate", {}, {}); },
  ]) { const f = materialFixture(); mutate(f); await assert.rejects(f.admit); }
});
test("full-tree admission rejects hidden paid/writes, unknown operations and exhausted rounds", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.act(f.prepare, "paid", "veya/model-generate", {}, {}),
    (f: ReturnType<typeof fixture>) => f.act(f.prepare, "write", "veya/world-apply", {}, {}),
    (f: ReturnType<typeof fixture>) => f.act(f.world, "other-copy", "veya/world-copy", { worldId: "foreign" }, { status: "succeeded" }),
    (f: ReturnType<typeof fixture>) => f.act(f.world, "other-enter", "veya/travel-enter", { worldId: "foreign" }, { status: "succeeded" }),
    (f: ReturnType<typeof fixture>) => f.act(f.build, "other-compose", "veya/draft-compose", { draftId: "foreign" }, {}),
    (f: ReturnType<typeof fixture>) => f.act(f.prepare, "cook", "veya/cooker-submit", { pipelineSource: "return {}" }, { operation_id: "cook_a", status: "running" }),
    (f: ReturnType<typeof fixture>) => { f.resume.round = 3; },
    (f: ReturnType<typeof fixture>) => { (f.prepare.output as any).costs = { status: "unknown" }; },
    (f: ReturnType<typeof fixture>) => { f.prepare.parent!.runId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.resume.gameplay.specHash = "9".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.root.status = "failed"; },
    (f: ReturnType<typeof fixture>) => { (f.root.input as any).previousArtifactId = "9".repeat(64); },
  ]) { const f = fixture(); mutate(f); await assert.rejects(f.admit, /world_production_recovery_unavailable/); }
});
test("completed Cooker identity is retained, independent of transport request and timeout", async () => {
  const f = fixture(), submission = { pipelineSource: "return {}", sources: [], inputs: [], timeoutSeconds: 300, requestId: "old" };
  f.act(f.prepare, "cook", "veya/cooker-submit", submission, { operation_id: "cook_a", status: "queued" });
  f.act(f.prepare, "wait", "veya/cooker-status", { operationId: "cook_a" }, { operation_id: "cook_a", status: "succeeded", cooker: { ok: true, steps: [{ ok: true, error: 0 }] } });
  const grant = await f.admit(); assert.equal(grant.proof.completedOperations[0]!.fingerprint,
    cookerSubmissionFingerprint({ pipeline_source: "return {}", sources: [], inputs: [], request_id: "new", timeout_seconds: 30 }));
  assert.notEqual(grant.proof.completedOperations[0]!.fingerprint, cookerSubmissionFingerprint({ pipeline_source: "return {x=1}" }));
});

test("production recovery proves completed local atmosphere source upgrades and rejects fabricated shader identity", async () => {
  function upgraded(immediate = false) {
    const f = fixture(), sources = { schemaVersion: 1, shaderSha256: "a".repeat(64), recipeSha256: "b".repeat(64), templateSha256: "c".repeat(64) };
    const request = { presetId: "blue_hour", seed: 1, source: "procedural", expectedSources: sources };
    const atmosphere = { assetId: "sky", contentHash: "d".repeat(64), shaderHash: sources.shaderSha256 };
    const env = { status: "ready", atmosphere }; (f.resume.build as any).environment = env;
    const producer = f.make("veya-environment-lighting", {}, env, f.build);
    const native = { id: "sky", type: "environment", content_hash: atmosphere.contentHash, atmosphere: { shader_sha256: sources.shaderSha256 } };
    const done = { operation_id: "cook_sky", status: "succeeded", cooker: { ok: true, steps: [{ ok: true, error: 0 }] }, assets: [native] };
    f.act(producer, "variant", "veya/atmosphere-build", request, immediate ? done : { operation_id: "cook_sky", status: "queued" });
    if (!immediate) f.act(producer, "wait", "veya/cooker-status", { operationId: "cook_sky" }, done);
    f.act(producer, "catalog", "veya/asset-list", {}, { sky: native });
    return { ...f, sources, request, atmosphere, producer, native, done };
  }
  for (const immediate of [false, true]) {
    const f = upgraded(immediate), grant = await f.admit();
    assert.equal(grant.proof.completedOperations[0]!.operation, "veya.atmosphere.build");
    assert.equal((grant.recovery.resume as any).build.environment.atmosphere.shaderHash, f.sources.shaderSha256);
    const call = async (op: string): Promise<any> => op === "veya.world.status" ? { profile: { player_id: f.owner, home_world_id: f.home } }
      : op === "veya.world.read" ? f.snapshot : op === "veya.draft.read" ? f.draft
      : op === "veya.assets.list" ? { raw: { content_hash: "f".repeat(64) }, sky: f.native } : undefined;
    await verifyProductionWorker(grant, call, 3);
    f.native.atmosphere.shader_sha256 = "f".repeat(64);
    await assert.rejects(() => verifyProductionWorker(grant, call, 3), /production_recovery_state_changed/);
  }
  for (const mutate of [
    (f: ReturnType<typeof upgraded>) => { f.request.source = "ai_cloud"; },
    (f: ReturnType<typeof upgraded>) => { f.sources.shaderSha256 = "e".repeat(64); },
    (f: ReturnType<typeof upgraded>) => { f.atmosphere.shaderHash = "f".repeat(64); },
    (f: ReturnType<typeof upgraded>) => { (f.producer.steps.at(-1)!.output as any).sky = { ...f.native, atmosphere: {} }; },
    (f: ReturnType<typeof upgraded>) => { f.done.status = "running"; },
    (f: ReturnType<typeof upgraded>) => { f.act(f.producer, "extra-wait", "veya/cooker-status", { operationId: "cook_sky" }, f.done); },
    (f: ReturnType<typeof upgraded>) => { (f.sources as any).extra = "fake"; },
  ]) { const f = upgraded(); mutate(f); await assert.rejects(f.admit); }
});
test("a completed sixteen-item asset batch obeys the same descendant checks", async () => {
  const f = fixture(), batch = f.make("veya-asset-batch", { requirements: Array.from({ length: 16 }, (_, i) => ({ id: "r" + i })) }, {}, f.build);
  await f.admit();
  (batch.input as any).requirements.push({ id: "r16" }); await assert.rejects(f.admit);
  (batch.input as any).requirements.pop(); f.act(batch, "hidden", "veya/model-generate", {}, {}); await assert.rejects(f.admit);
});

test("native atmosphere cache admission preserves actual round two, immutable resume and dedup fingerprint", async () => {
  const saved = JSON.parse(await readFile(new URL("./fixtures/atmosphere-cache-0c0.json", import.meta.url), "utf8"));
  const f = fixture(); f.resume.round = 2; (f.build.input as any).repairRound = 2;
  const env = { status: "ready", ...saved.output }; (f.resume.build as any).environment = env;
  const producer = f.make("veya-environment-lighting", saved.input, env, f.build);
  producer.steps = saved.steps;
  const bytes = JSON.stringify(f.resume), grant = await f.admit();
  assert.equal(grant.recovery.nextRound, 3);
  assert.equal(grant.recovery.noNewPaidWork, true); assert.equal(JSON.stringify(grant.recovery.resume), bytes);
  const submit = producer.steps.find(s => s.kind === "action" && s.actionId === "veya/atmosphere-build")!;
  assert.equal(submit.kind, "action"); if (submit.kind !== "action") throw new Error("fixture_action_missing");
  assert.deepEqual(grant.proof.completedOperations, [{ operation: "veya.atmosphere.build",
    operationId: (submit.output as any).operation_id, fingerprint: materialSubmissionFingerprint("veya.atmosphere.build", submit.input) }]);
  assert.ok(grant.proof.assets.some(a => a.contentHash === saved.output.atmosphere.contentHash));
  (submit.output as any).status = "queued";
  await assert.rejects(f.admit, /world_production_recovery_unavailable/);
  (submit.output as any).status = "succeeded"; f.resume.round = 3;
  await assert.rejects(f.admit, /world_production_recovery_unavailable/);
});
test("linked production retains fixed design and advances spent repair allowance without a new Plan", async () => {
  const f = fixture(), prior = await f.admit();
  const resume = { ...structuredClone(f.resume), round: 1 };
  const output = { status: "needs_attention", resume };
  const root = f.make("veya-wish", { operation: "create_world", text: f.text, homeWorldId: f.home, previousRequestId: f.root.requestId },
    { status: "blocked", brief: prior.recovery.brief, result: output });
  const world = f.make("veya-world-agent", { outputMode: "artifact", brief: prior.recovery.brief, continuation: [],
    resume: { ...structuredClone(prior.recovery.resume as object), round: 1 } }, output, root);
  const context = { creationId: root.requestId, homeWorldId: f.home, operation: "create_world", worldProductionRecovery: prior.recovery };
  f.act(root, "context", "veya/creator-context", {}, context); f.act(world, "context", "veya/creator-context", {}, context);
  f.make("veya-world-build", { ...f.build.input as object, repairRound: 1 }, resume.build, world);
  const admit = () => retainedWorldProduction(root, root.requestId, f.get, f.identity, { production: prior });
  assert.equal((await admit()).recovery.nextRound, 2);
  f.make("veya-world-plan", {}, resume.plan, world); await assert.rejects(admit, /world_production_recovery_unavailable/);
});

async function schemaFailureFixture() {
  const f = fixture(), prior = await f.admit(), resume = { ...structuredClone(f.resume), round: 1 };
  const output = { status: "needs_attention", resume, questions: [{ questionId: "garden.anchors", field: "garden.geometry",
    title: "Provide exact anchors", context: "Managed geometry is required", kind: "text", blocking: true,
    options: [], minSelections: 0, maxSelections: 1 }] };
  const root = f.make("veya-wish", { operation: "create_world", text: f.text, homeWorldId: f.home, previousRequestId: f.root.requestId }, undefined);
  root.status = "failed"; root.error = "步骤 Schema 必须可无损表示为受支持的 JSON Schema。";
  const world = f.make("veya-world-agent", { outputMode: "artifact", brief: prior.recovery.brief, continuation: [],
    resume: { ...structuredClone(prior.recovery.resume as object), round: 1 } }, output, root);
  const context = { creationId: root.requestId, homeWorldId: f.home, operation: "create_world", worldProductionRecovery: prior.recovery };
  f.act(root, "context", "veya/creator-context", {}, context); f.act(world, "context", "veya/creator-context", {}, context);
  const build = f.make("veya-world-build", { ...f.build.input as object, repairRound: 1 }, resume.build, world);
  return { ...f, root, world, build, resume, prior, output,
    admit: () => retainedWorldProduction(root, root.requestId, f.get, f.identity, { production: prior }) };
}
test("pre-durable checkpoint schema failure preserves the failed root and consumes its actual production round", async () => {
  const f = await schemaFailureFixture(), before = JSON.stringify(f.root);
  f.prior.proof.assets.push({ assetId: "retained_environment", contentHash: "9".repeat(64) });
  const grant = await f.admit();
  assert.equal(grant.recovery.nextRound, 2);
  assert.equal(grant.recovery.sourceRunId, f.root.id);
  assert.equal(grant.recovery.resumeHash, productionDigest(f.resume));
  assert.deepEqual(grant.recovery.continuation, []);
  assert.ok(grant.proof.assets.some(a => a.assetId === "retained_environment"), "opaque retained module dependencies stay pinned without a fresh module read");
  assert.equal(JSON.stringify(f.root), before, "no invented root output/checkpoint/answer or history rewrite");
});
test("checkpoint fault admission rejects other failures, answered checkpoints, unknown work and rewound rounds", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.root.error = "some other failure"; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.root.output = {}; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.root.commands = [{ requestId: randomUUID(), fingerprint: "a".repeat(64), status: "running", at: 1 }]; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.world.status = "failed"; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.output.questions = []; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.output.questions[0]!.kind = "executable"; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.output.questions[0]!.kind = "single"; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { Object.assign(f.output.questions[0]!, { kind: "multiple", options: [{ id: "a", label: "A" }, { id: "a", label: "Again" }], maxSelections: 2 }); },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { Object.assign(f.output.questions[0]!, { kind: "multiple", options: [{ id: "a", label: "A" }], minSelections: 2 }); },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { Object.assign(f.output.questions[0]!, { kind: "single", options: [{ id: "a", label: "A" }], maxSelections: 2 }); },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.resume.round = 0; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.resume.round = 3; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { (f.world.input as any).brief = { operation: "create_prop" }; },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.act(f.root, "extra", "veya/world-status", {}, {}); },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.root.steps.push({ kind: "checkpoint", status: "completed", id: "answer" } as never); },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.act(f.build, "hidden", "veya/cooker-submit", { pipelineSource: "return {}" }, { status: "running", operation_id: "cook_unknown" }); },
    (f: Awaited<ReturnType<typeof schemaFailureFixture>>) => { f.act(f.build, "paid", "veya/model-generate", {}, {}); },
  ]) { const f = await schemaFailureFixture(); mutate(f); await assert.rejects(f.admit); }
  const f = await schemaFailureFixture();
  await assert.rejects(() => retainedWorldProduction(f.root, f.root.requestId, f.get, f.identity, {}));
});
test("immutable grant storage and binding reject tamper, cross-identity and request combinations", async () => {
  const f = fixture(), grant = await f.admit(), root = await mkdtemp(join(tmpdir(), "aura-production-grant-"));
  try {
    const ref = await writeProductionGrant(root, grant); assert.deepEqual(await readProductionGrant(root, ref), grant);
    assert.deepEqual(await writeProductionGrant(root, grant), ref);
    const source = { ...f.identity, runId: f.root.id, sessionPath: "worker", input: { operation: "create_world", text: f.text } };
    const binding = { ...source, runId: "new", input: { operation: "create_world", text: f.text, previousRequestId: f.root.requestId }, recoveryBudgetCreationId: f.root.requestId };
    validateProductionBinding(grant, binding, source);
    for (const change of [{ playerId: "other" }, { homeWorldId: "other" }, { creationSessionId: "4".repeat(32) }, { sessionPath: "other" }, { assetReuse: {} }, { recovery: {} }, { worldDesignRecovery: {} }])
      assert.throws(() => validateProductionBinding(grant, { ...binding, ...change }, source));
    const path = join(root, ".aura/veya-creator/grants", ref.grantId + ".json");
    await writeFile(path, (await readFile(path, "utf8")) + " "); await assert.rejects(readProductionGrant(root, ref), /production_grant_invalid/);
    await assert.rejects(readProductionGrant(root, { ...ref, grantId: "../other" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("live read-only admission compares separate world/draft hashes, pins and owner", async () => {
  const f = fixture(), grant = await f.admit();
  const replies: Record<string, any> = { "veya.world.status": { playtest_id: "", profile: { player_id: f.owner, home_world_id: f.home } },
    "veya.world.read": f.snapshot, "veya.draft.read": f.draft, "veya.assets.list": { raw: { content_hash: "f".repeat(64) } } };
  const calls: string[] = [], invoke = async (op: string) => { calls.push(op); return replies[op]; };
  await verifyProductionWorker(grant, invoke, 3); assert.equal(calls.some(s => /enter|compose|create|submit/.test(s)), false);
  for (const [op, field, wrong] of [["veya.world.read", "content_hash", "8".repeat(64)], ["veya.draft.read", "draft_revision", 2],
    ["veya.world.status", "playtest_id", "test_foreign"]] as const) {
    const old = replies[op][field]; replies[op][field] = wrong; await assert.rejects(verifyProductionWorker(grant, invoke, 3)); replies[op][field] = old;
  }
  replies["veya.assets.list"].raw.content_hash = "8".repeat(64); await assert.rejects(verifyProductionWorker(grant, invoke, 3));
  await assert.rejects(verifyProductionWorker(grant, invoke, 0));
});

test("visual provenance pins both legacy binding and typed visual-context collision hashes", async () => {
  const f = fixture(), built: any = f.resume.build;
  built.visualContext = { props: [{ assets: [{ assetId: "visual", contentHash: "7".repeat(64), sourceAssetId: "raw",
    sourceContentHash: "f".repeat(64), collisionAssetId: "collision", collisionContentHash: "8".repeat(64) }] }] };
  const catalog = (f.build.steps.find(s => s.kind === "action" && s.actionId === "veya/asset-list")!.output as any);
  catalog.visual = { content_hash: "7".repeat(64) }; catalog.collision = { content_hash: "8".repeat(64) };
  const asset = built.visualContext.props[0].assets[0];
  const accepted = await f.admit();
  assert.ok(accepted.proof.assets.some(p => p.assetId === "collision" && p.contentHash === asset.collisionContentHash));
  asset.collisionVersion = asset.collisionContentHash; await f.admit();
  asset.collisionVersion = "9".repeat(64); await assert.rejects(f.admit); delete asset.collisionVersion;
  asset.collisionContentHash = "9".repeat(64); await assert.rejects(f.admit); asset.collisionContentHash = "8".repeat(64);
  asset.sourceContentHash = "9".repeat(64); await assert.rejects(f.admit); asset.sourceContentHash = "f".repeat(64);
  delete catalog.raw; await assert.rejects(f.admit);
});
test("a later completed compose is guarded without rewriting the coordinator's original resume draft", async () => {
  const f = fixture(), latest = { ...structuredClone(f.draft), draft_revision: 2, content_hash: "8".repeat(64) };
  f.act(f.build, "compose", "veya/draft-compose", { draftId: f.draft.draft_id, expectedDraftRevision: 1 }, latest);
  const grant = await f.admit();
  assert.equal((grant.recovery.resume as any).draft.draft_revision, 1); assert.equal((grant.proof.draft as any).draft_revision, 2);
  const replies: any = { "veya.world.status": { playtest_id: "", profile: { player_id: f.owner, home_world_id: f.home } },
    "veya.world.read": f.snapshot, "veya.draft.read": latest, "veya.assets.list": { raw: { content_hash: "f".repeat(64) } } };
  await verifyProductionWorker(grant, async op => replies[op], 3);
  replies["veya.draft.read"] = f.draft; await assert.rejects(verifyProductionWorker(grant, async op => replies[op], 3));
});
test("service persists only an opaque production grant and reloads it without growing the bindings payload", async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), "aura-production-service-")), worker = join(root, "worker.json");
  try {
    const starts = new Map<string, FlowRun>(); let loseStartResponse = true;
    const flow = { request: async (op: string, input: any) => {
      if (op === "catalog") return { flows: [{ id: "veya/veya-wish", available: true, service: true }] };
      if (op === "get") return f.get(input.id);
      assert.equal(op, "start");
      if (starts.has(input.requestId)) return starts.get(input.requestId)!;
      const run = { id: randomUUID(), requestId: input.requestId, flow: { id: input.flowId }, input: input.input, status: "running", steps: [] } as unknown as FlowRun;
      f.runs.set(run.id, run); starts.set(input.requestId, run);
      if (loseStartResponse) { loseStartResponse = false; throw new Error("lost_start_response"); } return run;
    } };
    const service = new VeyaCreatorService(root, flow as never); await service.initialize();
    const source = { ...f.identity, kind: "world", sessionPath: worker, runId: f.root.id, input: { operation: "create_world", text: f.text } };
    const indexPath = join(root, ".aura/veya-creator/bindings.json");
    await writeFile(indexPath, JSON.stringify({ version: 1, bindings: { [f.root.requestId]: source } })); await service.initialize();
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: f.identity.creationSessionId,
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49999/", token: "a".repeat(64) }));
    const token = await service.register(f.identity.playerId, f.home, worker), client = service.client("Bearer " + token)!;
    const requestId = randomUUID(), input = { operation: "create_world" as const, text: f.text, previousRequestId: f.root.requestId };
    await assert.rejects(service.submit(client, requestId, input), /lost_start_response/);
    const restarted = new VeyaCreatorService(root, flow as never); await restarted.initialize();
    const submitted = await restarted.submit(client, requestId, input);
    const bytes = await readFile(indexPath), binding = JSON.parse(bytes.toString()).bindings[submitted.requestId];
    assert.ok(binding.worldProductionRecoveryRef); assert.equal(binding.worldDesignRecovery, undefined); assert.equal(binding.assetReuse, undefined);
    assert.equal(binding.recovery, undefined); assert.equal(binding.resume, undefined); assert.ok(bytes.length < 4096);
    assert.equal(binding.productionRecoveryClaimVersion, 1); assert.match(binding.productionRecoveryClaim, /^[a-f0-9]{64}$/);
    const downgrade = JSON.parse(bytes.toString());
    delete downgrade.bindings[requestId].productionRecoveryClaimVersion; delete downgrade.bindings[requestId].productionRecoveryClaim;
    await assert.rejects((restarted as any).commit(downgrade), /production_recovery_claim_invalid/);
    const newUnmarked = JSON.parse(bytes.toString());
    newUnmarked.bindings[randomUUID()] = downgrade.bindings[requestId];
    await assert.rejects((restarted as any).commit(newUnmarked), /production_recovery_claim_invalid/);
    assert.equal((await readProductionGrant(root, binding.worldProductionRecoveryRef)).recovery.resumeHash, productionDigest(f.resume));
    await new VeyaCreatorService(root, flow as never).initialize();
    assert.equal((await restarted.submit(client, requestId, input)).runId, submitted.runId);
    assert.equal(starts.size, 1, "response retry has the same durable start identity");
    await assert.rejects(restarted.submit(client, requestId, { ...input, text: "changed" }), /request_id_conflict/);
    starts.get(requestId)!.status = "completed";
    await assert.rejects(restarted.submit(client, randomUUID(), input), /production_round_already_claimed/);
    assert.ok(bytes.equals(await readFile(indexPath)), "a rejected competitor cannot mutate the committed claim");
    const missingClaim = JSON.parse(bytes.toString()); delete missingClaim.bindings[requestId].productionRecoveryClaim;
    await writeFile(indexPath, JSON.stringify(missingClaim));
    await assert.rejects(new VeyaCreatorService(root, flow as never).initialize(), /production_recovery_claim_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
