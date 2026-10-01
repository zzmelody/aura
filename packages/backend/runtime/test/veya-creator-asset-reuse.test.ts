import assert from "node:assert/strict";
import { readCreatorBindingDocument } from "@aura/orchestration";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { inheritedDesignAssets, retainedCommonAssets } from "../src/veya-creator-asset-reuse.ts";
import { VeyaCreatorService, createVeyaCreatorApp } from "../src/veya-creator-routes.ts";

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function fixture() {
  const requestId = randomUUID(), runs = new Map<string, FlowRun>();
  const make = (id: string, input = {}, output = {}, parent?: FlowRun) => {
    const run = { id: randomUUID(), requestId: parent ? randomUUID() : requestId, flow: { id: "veya/" + id }, status: "completed", input, output, steps: [] } as unknown as FlowRun;
    if (parent) {
      const step = { id: id === "veya-world-assets" ? "world-assets" : id, stepKey: "main/" + id, kind: "flow", status: "completed", childRunId: run.id };
      parent.steps.push(step as FlowRun["steps"][number]); run.parent = { runId: parent.id, stepKey: step.stepKey };
    }
    runs.set(run.id, run); return run;
  };
  const action = (run: FlowRun, id: string, actionId: string, input: object, output: object) => {
    const step = { id, stepKey: "main/" + id, kind: "action", status: "completed", actionId, input, output };
    run.steps.push(step as FlowRun["steps"][number]); return step;
  };
  const requirement = { id: "garden", kind: "procedural", description: "Fixed common courtyard", requiredActions: [] };
  const mesh = "return cooker.mesh({})", scene = "return cooker.scene({})";
  const sourceHash = digest([digest([requirement.id, requirement.description, "", "procedural-v1"]), mesh, scene]);
  const operationId = "cook_" + "1".repeat(32);
  const binding = { requirementId: requirement.id, assetId: "garden_visual", version: "a".repeat(64), collisionAssetId: "garden_collision",
    collisionVersion: "b".repeat(64), navigationAssetId: "garden_navigation", navigationVersion: "c".repeat(64), source: "procedural" };
  const assets = { schemaVersion: 2, status: "ready", bindings: [binding], issues: [], costs: { status: "not_incurred", credits: 0, records: [] }, retainedArtifacts: [], retryable: false };
  const root = make("veya-wish", { operation: "create_world", text: "original courtyard" }, { status: "blocked" });
  const world = make("veya-world-agent", {}, { status: "needs_attention" }, root);
  const build = make("veya-world-build", { repairRound: 0, plan: { assets: [requirement] }, gameplaySpec: { assets: [requirement], props: [] } }, { status: "blocked", assets }, world);
  const assetRun = make("veya-world-assets", { requirements: [requirement], defects: [] }, assets, build);
  const producer = make("veya-procedural-asset", { requirementId: requirement.id, description: requirement.description, revisionHint: "" }, {
    schemaVersion: 1, status: "ready", operationId, sourceHash,
    visual: { assetId: binding.assetId, version: binding.version }, collision: { assetId: binding.collisionAssetId, version: binding.collisionVersion },
    navigation: { assetId: binding.navigationAssetId, version: binding.navigationVersion },
  }, assetRun);
  const catalog = [
    { id: binding.assetId, content_hash: binding.version, type: "model", source_asset_id: `proc_${sourceHash.slice(0, 40)}_visual`, local_generated: true },
    { id: binding.collisionAssetId, content_hash: binding.collisionVersion, type: "model", source_asset_id: `proc_${sourceHash.slice(0, 40)}_collision`, local_generated: true },
    { id: binding.navigationAssetId, content_hash: binding.navigationVersion, type: "navigation", source_asset_id: `proc_${sourceHash.slice(0, 40)}_navigation`, local_generated: true },
  ];
  const submit = action(producer, "submit", "veya/cooker-submit", { sources: [
    { path: "content/scripts/cooker/agent_generated/mesh.luau", source: mesh }, { path: "content/scripts/cooker/agent_generated/scene.luau", source: scene },
  ] }, { operation_id: operationId, status: "queued" });
  const wait = action(producer, "wait", "veya/cooker-status", { operationId }, { operation_id: operationId, status: "succeeded", assets: catalog,
    cooker: { ok: true, steps: Array.from({ length: 10 }, () => ({ ok: true, error: 0 })) } });
  return { root, world, build, assetRun, producer, requestId, requirement, binding, assets, catalog, submit, wait, action, runs,
    get: async (id: string) => { const run = runs.get(id); if (!run) throw new Error("missing"); return run; } };
}

// Earlier recovery tests only admit read-only design or paid props; they cannot
// prove a succeeded common Cooker product without granting old world state.
test("common asset reuse proves its public producer and exports only opaque immutable references", async () => {
  const f = fixture(), original = JSON.stringify([...f.runs.values()]);
  const grant = await retainedCommonAssets(f.root, f.requestId, f.get);
  assert.deepEqual(grant.items[0]?.requirement, f.requirement); assert.deepEqual(grant.items[0]?.binding, f.binding);
  assert.equal(grant.items[0]?.producer.runId, f.producer.id); assert.equal(grant.sourceRunId, f.root.id);
  assert.equal(JSON.stringify([...f.runs.values()]), original);
  assert.equal(JSON.stringify(grant).includes("sources"), false); assert.equal(JSON.stringify(grant).includes("costs"), false);
  assert.equal(JSON.stringify(grant).includes("repairRound"), false);
});

// A fresh asset-reuse task may fail before any production because its Design
// JSON is malformed. The existing generic recovery did not preserve its grant.
test("read-only world design continuation re-proves and inherits only its existing common grant", async () => {
  const f = fixture(), grant = await retainedCommonAssets(f.root, f.requestId, f.get), sourceRequestId = randomUUID();
  const make = (flow: string, input: object, output: object) => {
    const r = { id: randomUUID(), requestId: randomUUID(), flow: { id: "veya/" + flow }, input, output, status: "completed", steps: [] } as unknown as FlowRun;
    f.runs.set(r.id, r); return r;
  };
  const link = (parent: FlowRun, child: FlowRun, id: string) => {
    const stepKey = "main/" + id; child.parent = { runId: parent.id, stepKey };
    parent.steps.push({ id, stepKey, kind: "flow", status: "completed", childRunId: child.id } as never);
  };
  const agent = (r: FlowRun, id: string, output: string) => r.steps.push({ id, kind: "agent", stepKey: "main/" + id, status: "completed", output, actions: [] } as never);
  const brief = { schemaVersion: 1, operation: "create_world", summary: "courtyard", constraints: [], acceptance: [] };
  const plan = { operation: "copy", targetWorldId: "creation-template", gaps: [], requirements: brief, assets: [f.requirement] };
  const source = make("veya-wish", { operation: "create_world", text: "original courtyard", homeWorldId: "home", reuseAssetsFromRequestId: f.requestId }, { status: "blocked" });
  source.requestId = sourceRequestId;
  const world = make("veya-world-agent", { task: "courtyard", outputMode: "artifact", brief }, { status: "needs_attention" });
  const planner = make("veya-world-plan", { brief }, plan);
  const design = make("veya-world-gameplay-design", { scope: "world", modular: true, task: "courtyard", plan: { ...plan,
    returnHome: { schemaVersion: 1, binding: "personal_home", entityId: "return_home", arrival: "home_return" } } },
    { status: "blocked", issues: [{ code: "invalid_spec", detail: "SyntaxError" }] });
  const context = { creationId: sourceRequestId, operation: "create_world", assetReuse: grant };
  f.action(source, "context", "veya/creator-context", {}, structuredClone(context)); agent(source, "understand-0", "{}"); link(source, world, "world");
  f.action(world, "creator-context", "veya/creator-context", {}, structuredClone(context)); link(world, planner, "plan"); link(world, design, "gameplay-design");
  agent(planner, "plan", "{}"); f.action(design, "capabilities", "veya/system-context", {}, {}); agent(design, "draft", '{"x":[1}]}');
  const directory = await mkdtemp(join(tmpdir(), "aura-design-assets-")), worker = join(directory, "worker.json");
  try {
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "e".repeat(32), protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49222/", token: "a".repeat(64) }));
    const service = new VeyaCreatorService(directory, { async request<T>(method: string, params: Record<string, any>): Promise<T> {
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", available: true, service: true }] } as T;
      if (method === "get") return await f.get(params.id) as T;
      if (method === "start") {
        if (params.requestId === f.requestId) return f.root as T;
        if (params.requestId === sourceRequestId) return source as T;
        const r = make("veya-wish", params.input, { status: "blocked" }); r.requestId = params.requestId; return r as T;
      }
      throw new Error("unexpected");
    } } as any);
    await service.initialize(); const token = await service.register("player", "home", worker), app = createVeyaCreatorApp(service);
    const send = (body: object) => app.request("/tasks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
    const initial = { requestId: f.requestId, operation: "create_world", text: "original courtyard" };
    assert.equal((await send(initial)).status, 202);
    assert.equal((await send({ ...initial, requestId: sourceRequestId, reuseAssetsFromRequestId: f.requestId })).status, 202);
    const next = { ...initial, requestId: randomUUID(), previousRequestId: sourceRequestId };
    assert.equal((await send({ ...next, reuseAssetsFromRequestId: f.requestId })).status, 400);
    assert.equal((await send(next)).status, 202);
    const file = join(directory, ".aura/veya-creator/bindings.json"), stored = await readCreatorBindingDocument(directory, await readFile(file));
    const held = stored.bindings[next.requestId];
    assert.deepEqual(held.assetReuse, grant); assert.equal(held.worldDesignRecovery.draftText, '{"x":[1}]}');
    assert.equal(held.worldDesignRecovery.formatCorrectionUsed, false); assert.equal(held.recoveryBudgetCreationId, sourceRequestId);
    assert.notEqual(held.recoveryBudgetCreationId, f.requestId, "does not inherit the asset producer task's budget");
    assert.equal(held.input.reuseAssetsFromRequestId, undefined); assert.equal(held.recovery, undefined);
    await service.initialize();
    // The actual new format path has no format Agent: it may reach the one
    // semantic revise and retain that exact result for a single read-only review.
    const continuation = await f.get(held.runId), revisionContext = { creationId: next.requestId,
      operation: "create_world", assetReuse: structuredClone(grant), worldDesignRecovery: structuredClone(held.worldDesignRecovery) };
    const continuedWorld = make("veya-world-agent", { ...world.input as object, designRecovery: structuredClone(held.worldDesignRecovery) }, { status: "needs_attention" });
    const revisedText = '{"x":[2]}', hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const continuedDesign = make("veya-world-gameplay-design", { ...design.input as object,
      formatDraft: { text: held.worldDesignRecovery.draftText, hash: held.worldDesignRecovery.draftHash } },
      { status: "blocked", issues: [{ code: "playability_review", detail: "retained criticism" }], designRevision: {
        beforeHash: held.worldDesignRecovery.draftHash, afterHash: hash(revisedText), formatCorrected: true,
        formatMethod: "unique_closing_bracket", formatOffset: 7, formatOffsets: [7],
        formatSourceHash: held.worldDesignRecovery.draftHash, formatResultHash: hash('{"x":[1]}'), issues: [{ code: "invalid_spec" }],
      } });
    f.action(continuation, "context", "veya/creator-context", {}, structuredClone(revisionContext)); link(continuation, continuedWorld, "world");
    f.action(continuedWorld, "creator-context", "veya/creator-context", {}, structuredClone(revisionContext)); link(continuedWorld, continuedDesign, "gameplay-design");
    f.action(continuedDesign, "capabilities", "veya/system-context", {}, {}); agent(continuedDesign, "revise", revisedText);
    agent(continuedDesign, "review-revision", JSON.stringify({ criticalIssues: ["retained criticism"], notes: [] }));
    const reviewRequest = { ...initial, requestId: randomUUID(), previousRequestId: next.requestId };
    const changedContext = (continuation.steps[0] as any).output.assetReuse;
    (continuation.steps[0] as any).output.assetReuse = { ...changedContext, sourceRunId: randomUUID() };
    assert.equal((await send(reviewRequest)).status, 409, "second layer cannot replace the durable grant");
    (continuation.steps[0] as any).output.assetReuse = changedContext;
    const originalMesh = (f.submit.input as any).sources[0].source; (f.submit.input as any).sources[0].source += " changed";
    assert.equal((await send(reviewRequest)).status, 409, "second layer re-reads the original complete producer");
    (f.submit.input as any).sources[0].source = originalMesh;
    const acceptedReview = await send(reviewRequest);
    assert.equal(acceptedReview.status, 202, await acceptedReview.text());
    const twice = (await readCreatorBindingDocument(directory, await readFile(file))).bindings[reviewRequest.requestId]!;
    assert.deepEqual(twice.assetReuse, grant); assert.deepEqual(twice.worldDesignRecovery.retainedSpec, { x: [2] });
    assert.equal(twice.worldDesignRecovery.reviewRetryUsed, true); assert.equal(twice.worldDesignRecovery.semanticRevisionUsed, true);
    assert.equal(twice.recoveryBudgetCreationId, sourceRequestId); assert.equal(twice.input.reuseAssetsFromRequestId, undefined);
    await service.initialize();
    assert.equal((await send({ ...reviewRequest, requestId: randomUUID(), previousRequestId: reviewRequest.requestId })).status, 409,
      "a spent review cannot become an unbounded recovery chain");
    assert.equal((await send({ ...next, requestId: randomUUID(), text: "changed" })).status, 409);
    const originalHash = f.binding.version; f.binding.version = "d".repeat(64);
    assert.equal((await send({ ...next, requestId: randomUUID() })).status, 409, "original producer is read again, not trusted from cached grant");
    f.binding.version = originalHash;
    (source.steps[0] as any).output.assetReuse.items[0].binding.version = "d".repeat(64);
    assert.equal((await send({ ...next, requestId: randomUUID() })).status, 409, "source durable context must exactly match the admitted grant");
    (source.steps[0] as any).output.assetReuse = structuredClone(grant);
    await assert.rejects(inheritedDesignAssets(source, { ...plan, assets: [{ ...f.requirement, description: "changed" }] }, grant, f.get), /asset_reuse_unavailable/u);
    stored.bindings[sourceRequestId].creationSessionId = "f".repeat(32);
    await writeFile(file, JSON.stringify(stored));
    await assert.rejects(service.initialize(), /asset_reuse_unavailable/u, "persisted inheritance is pinned to the same source session");
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); await rm(directory, { recursive: true, force: true });
  }
});

test("common asset reuse refuses unfinished, unknown, private, changed and unproved assets", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.root.status = "failed"; }, f => { f.producer.status = "running"; },
    f => { f.wait.status = "running"; }, f => { (f.wait.output as any).status = "failed"; },
    f => { f.assets.costs.status = "unknown"; }, f => { f.assets.costs.credits = 1; },
    f => { (f.root.input as any).previousRequestId = randomUUID(); },
    f => { (f.build.input as any).repairRound = 1; },
    f => { (f.build.input as any).gameplaySpec.props = [{ assets: [f.requirement] }]; },
    f => { (f.producer.input as any).description = "Changed geometry"; },
    f => { (f.build.input as any).plan.assets = [{ ...f.requirement, description: "Changed" }]; },
    f => { (f.requirement as any).requiredActions = ["walk"]; },
    f => { (f.requirement as any).kind = "humanoid"; },
    f => { f.binding.navigationVersion = "f".repeat(64); },
    f => { f.catalog[0]!.type = "character"; }, f => { f.catalog[1]!.source_asset_id = "unrelated"; },
    f => { (f.producer.output as any).operationId = "cook_" + "2".repeat(32); },
    f => { (f.submit.input as any).sources[0].source = "changed"; },
    f => { (f.wait.output as any).cooker.steps[9].ok = false; },
    f => { f.action(f.assetRun, "hidden", "veya/model-generator", {}, {}); },
    f => { f.producer.parent!.runId = randomUUID(); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(retainedCommonAssets(f.root, f.requestId, f.get), /asset_reuse_(?:unavailable|catalog_mismatch)/u);
  }
});

test("asset source identity is fingerprinted, owned, mutually exclusive and grants no recovery budget", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "aura-common-assets-")), worker = join(directory, "worker.json");
  const starts: Record<string, any>[] = [];
  try {
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "e".repeat(32), protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49222/", token: "a".repeat(64) }));
    const service = new VeyaCreatorService(directory, { async request<T>(method: string, params: Record<string, any>): Promise<T> {
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", available: true, service: true }] } as T;
      if (method === "get") return await f.get(params.id) as T;
      if (method === "start") {
        starts.push(params);
        if (params.requestId === f.requestId) return f.root as T;
        const run = { ...f.root, id: randomUUID(), requestId: params.requestId, input: params.input };
        f.runs.set(run.id, run); return run as T;
      }
      throw new Error("Unexpected operation");
    } } as any);
    await service.initialize(); const token = await service.register("player", "home", worker), app = createVeyaCreatorApp(service);
    const send = (body: object) => app.request("/tasks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
    const initial = { requestId: f.requestId, operation: "create_world", text: "original courtyard" };
    assert.equal((await send(initial)).status, 202);
    const next = { ...initial, requestId: randomUUID(), reuseAssetsFromRequestId: f.requestId };
    assert.equal((await send(next)).status, 202);
    const saved = JSON.parse(await readFile(join(directory, ".aura/veya-creator/bindings.json"), "utf8"));
    const bound = saved.bindings[next.requestId];
    assert.deepEqual(bound.assetReuse.items[0].binding, f.binding);
    for (const key of ["recovery", "worldDesignRecovery", "recoveryBudgetCreationId", "previousArtifact"]) assert.equal(bound[key], undefined);
    assert.equal((await send({ ...next, reuseAssetsFromRequestId: randomUUID() })).status, 409);
    for (const patch of [{ previousRequestId: f.requestId }, { previousArtifactId: "f".repeat(64) }, { operation: "create_prop" },
      { targetWorldId: "elsewhere" }, { references: [] }, { assetReuse: bound.assetReuse }])
      assert.equal((await send({ ...next, requestId: randomUUID(), ...patch })).status, 400);
    assert.equal((await send({ ...next, requestId: randomUUID(), text: "changed demand" })).status, 409);
    saved.bindings[f.requestId].playerId = "another";
    await writeFile(join(directory, ".aura/veya-creator/bindings.json"), JSON.stringify(saved));
    await service.initialize();
    assert.equal((await send({ ...next, requestId: randomUUID() })).status, 409);
    assert.equal(starts.length, 2);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); await rm(directory, { recursive: true, force: true });
  }
});
