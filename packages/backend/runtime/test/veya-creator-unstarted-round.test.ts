import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { productionDigest, validateProductionGrant, readProductionGrant, type ProductionGrant } from "@aura/orchestration";
import { recoverUnstartedFinalRound, UNSTARTED_BUILD_HASH, UNSTARTED_ENV_HASH } from "../src/veya-creator-unstarted-round.ts";
import { VeyaCreatorService } from "../src/veya-creator-routes.ts";

// The existing recovery tests only admit terminal rounds below three. These
// tests cover a known pre-author routing bug and its one-successor reservation.
function fixture() {
  const text = "unchanged courtyard", worldId = "a".repeat(32), home = "b".repeat(32), moduleId = "c".repeat(64);
  const draft = { draft_id: "d".repeat(32), draft_revision: 2, world_id: worldId, base_revision: 1, content_hash: "e".repeat(64) };
  const identity = { playerId: "player", homeWorldId: home, creationSessionId: "f".repeat(32), textHash: createHash("sha256").update(text).digest("hex") };
  const ref = { module_id: moduleId, content_hash: moduleId, kind: "environment", schema_version: 1 };
  const costs = { status: "not_incurred", credits: 0 }, environment = { status: "ready", module: ref, costs,
    environmentResource: { atmosphere: { assetId: "upgraded", contentHash: "1".repeat(64), shaderHash: "2".repeat(64) } } };
  const diagnostic = { code: "creation_validation_failed", stage: "author", namespace: "environment", module_id: moduleId };
  const defects = [{ id: "compose-0", severity: "error", owner: "environment", description: "Native candidate validation: " +
    JSON.stringify({ code: diagnostic.code, stage: diagnostic.stage, module_id: moduleId, namespace: "environment" }) }];
  const spec = { props: [], entities: [{ id: "plaque" }] }, resolved = { props: [], entities: [{ id: "prop_abc:plaque" }] };
  const plan = { operation: "copy", targetWorldId: "creation-template" }, gameplay = { status: "ready", spec, specHash: productionDigest(spec) };
  const buildOutput: any = { status: "blocked", gameplaySpec: resolved, environment, defects,
    modules: [{ namespace: "environment", module: ref }], assets: { status: "ready", bindings: [] }, props: [], effects: {}, allowedChanges: [], entityBindings: [] };
  const make = (id: string, input: any, output: any) => ({ id: randomUUID(), requestId: randomUUID(), flow: { id: "veya/" + id },
    input, output, status: "completed", steps: [] } as unknown as FlowRun);
  const act = (r: FlowRun, id: string, actionId: string) => r.steps.push({ id, stepKey: "plugin/main/" + id, kind: "action", actionId, status: "completed", input: {}, output: {} } as never);
  const child = (p: FlowRun, r: FlowRun, id: string) => { r.parent = { runId: p.id, stepKey: "plugin/main/" + id };
    p.steps.push({ id, stepKey: r.parent.stepKey, kind: "flow", status: "completed", childRunId: r.id } as never); };
  const root = make("veya-wish", { operation: "create_world", text }, {}), world = make("veya-world-agent", {}, {});
  act(root, "context", "veya/creator-context"); child(root, world, "world");
  for (const [id, op] of [["creator-context", "creator-context"], ["worlds", "world-list"], ["enter", "travel-enter"], ["enter-wait-0", "operation-status"]]) act(world, id!, "veya/" + op);
  const input = { plan, gameplaySpec: spec, gameplaySpecHash: gameplay.specHash, generationScope: "3".repeat(64), draftId: draft.draft_id };
  const b2 = make("veya-world-build", { ...input, repairRound: 2 }, buildOutput); b2.flow.sourceHash = UNSTARTED_BUILD_HASH;
  child(world, b2, "build-2");
  b2.steps.push({ id: "compose", kind: "action", stepKey: "plugin/main/compose", actionId: "veya/draft-compose", status: "failed",
    error: `Veya creation_validation_failed (HTTP 422). diagnostics=${JSON.stringify([diagnostic])}` } as never);
  const message = "Candidate-bound visual evidence is required for lighting repair.";
  const envOutput = { status: "blocked", issues: [{ code: "lookdev_blocked", detail: message }], questions: [], retained: [ref], costs, environmentResource: environment.environmentResource };
  const b3 = make("veya-world-build", { ...input, repairRound: 3, previous: buildOutput, verification: { defects }, defects },
    { ...buildOutput, gameplaySpec: spec, environment: envOutput, modules: [], questions: [], issues: [message], defects: [] });
  b3.flow.sourceHash = UNSTARTED_BUILD_HASH; child(world, b3, "build-3");
  for (const [id, op] of [["appearance-source", "world-read"], ["appearance-catalog", "asset-list"], ["draft-budget", "draft-read"],
    ["asset-budget-catalog", "asset-list"], ["layout-exports", "creation-module-read"], ["retained-environment-exports", "creation-module-read"]]) act(b3, id!, "veya/" + op);
  const env = make("veya-environment-lighting", { repairRound: 3, previous: environment, verification: { defects }, generationScope: input.generationScope }, envOutput);
  env.flow.sourceHash = UNSTARTED_ENV_HASH; child(b3, env, "environment");
  for (const [id, op] of [["layout-source", "creation-module-read"], ["layout-catalog", "asset-list"], ["implementation-sources", "cooker-capabilities"]]) act(env, id!, "veya/" + op);
  const terminal = { plan, gameplay, source: {}, worldId, draft, build: b3.output, round: 3, generationScope: input.generationScope, verification: { defects } };
  world.output = { resume: terminal } as never; root.output = { status: "blocked", result: world.output } as never;
  const prior: ProductionGrant = { version: 1, identity, recovery: { schemaVersion: 1, sourceRequestId: randomUUID(), sourceRunId: randomUUID(),
    brief: { operation: "create_world" }, continuation: [], resume: { ...terminal, round: 1 } as never, resumeHash: "4".repeat(64), noNewPaidWork: true, nextRound: 2 },
    proof: { world: { worldId, ownerId: "5".repeat(32), revision: 1, contentHash: "6".repeat(64) }, draft, assets: [], modules: [], completedOperations: [] } };
  const runs = [root, world, b2, b3, env];
  const recover = () => recoverUnstartedFinalRound(root, world, runs, prior)!;
  const grant = (): ProductionGrant => { const result = recover(); return validateProductionGrant({ ...prior,
    recovery: { ...prior.recovery, sourceRequestId: root.requestId, sourceRunId: root.id, resume: result.resume,
      resumeHash: productionDigest(result.resume), nextRound: 3 }, proof: { ...prior.proof, pendingRound: result.boundary } }); };
  return { root, world, b2, b3, env, prior, terminal, runs, recover, grant, act, text, identity, home };
}

test("only the proven pre-author final round reconstructs the complete prior Build without editing history", () => {
  const f = fixture(), bytes = JSON.stringify(f.runs), recovered = f.recover(), grant = f.grant();
  assert.equal(recovered.resume.round, 2); assert.equal(grant.recovery.nextRound, 3);
  assert.deepEqual(recovered.resume.build, f.b2.output); assert.equal(recovered.boundary.blockedInputHash, productionDigest(f.b3.input));
  assert.equal(JSON.stringify(f.runs), bytes); assert.equal(f.terminal.round, 3);
  assert.equal(grant.recovery.resumeHash, productionDigest(recovered.resume));
  assert.equal("pendingRound" in grant.recovery, false, "proof stays host-private");
});

test("an executed, uncertain, different or already-claimed final round cannot use the routing exception", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.env.steps.push({ kind: "agent", status: "completed", actions: [] } as never); },
    (f: ReturnType<typeof fixture>) => { f.act(f.env, "cook", "veya/atmosphere-build"); },
    (f: ReturnType<typeof fixture>) => { f.env.steps[0]!.status = "failed"; },
    (f: ReturnType<typeof fixture>) => { f.env.flow.sourceHash = "7".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.runs.push({ ...f.env, id: randomUUID(), parent: { runId: f.env.id, stepKey: "hidden" } }); },
    (f: ReturnType<typeof fixture>) => { (f.env.output as any).issues[0].detail = "another failure"; },
    (f: ReturnType<typeof fixture>) => { (f.b3.input as any).previous = { ...f.b2.output as object, changed: true }; },
    (f: ReturnType<typeof fixture>) => { (f.b3.input as any).gameplaySpecHash = "8".repeat(64); },
    (f: ReturnType<typeof fixture>) => { (f.b3.input as any).draftId = "other"; },
    (f: ReturnType<typeof fixture>) => { f.b2.steps[0]!.error = "Veya unknown (HTTP 500)."; },
    (f: ReturnType<typeof fixture>) => { (f.env.output as any).retained = []; },
    (f: ReturnType<typeof fixture>) => { (f.env.output as any).environmentResource = { changed: true }; },
    (f: ReturnType<typeof fixture>) => { f.world.steps.reverse(); },
    (f: ReturnType<typeof fixture>) => { f.prior.proof.pendingRound = f.grant().proof.pendingRound; },
  ]) { const f = fixture(); mutate(f); assert.throws(f.recover, /world_production_recovery_unavailable/); }
});

test("pending proof rejects a tampered boundary, output or counter", () => {
  for (const change of [
    (g: ProductionGrant) => { g.proof.pendingRound!.completedOutputHash = "9".repeat(64); },
    (g: ProductionGrant) => { g.proof.pendingRound!.resolvedSpecHash = "9".repeat(64); },
    (g: ProductionGrant) => { (g.proof.pendingRound as any).extra = true; },
    (g: ProductionGrant) => { (g.recovery.resume as any).round = 3; g.recovery.nextRound = 4; g.recovery.resumeHash = productionDigest(g.recovery.resume); },
  ]) { const g = fixture().grant(); change(g); assert.throws(() => validateProductionGrant(g)); }
});

test("one durable successor survives lost start response and restart; another request and duplicate index are refused", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "aura-pending-round-"));
  try {
    const worker = join(directory, "worker.json"), byId = new Map(f.runs.map(r => [r.id, r])), started = new Map<string, FlowRun>();
    let loseResponse = true, rejectProof = true;
    const flow = { request: async (op: string, input: any) => {
      if (op === "catalog") return { flows: [{ id: "veya/veya-wish", available: true, service: true }] };
      if (op === "get") { const r = byId.get(input.id); assert.ok(r); return r; }
      assert.equal(op, "start");
      if (!started.has(input.requestId)) { const r = { id: randomUUID(), requestId: input.requestId, flow: { id: input.flowId }, status: "completed", steps: [] } as unknown as FlowRun;
        started.set(input.requestId, r); byId.set(r.id, r); }
      if (loseResponse) { loseResponse = false; throw new Error("response_lost"); }
      return started.get(input.requestId);
    } };
    const service = new VeyaCreatorService(directory, flow as never); await service.initialize();
    const path = join(directory, ".aura/veya-creator/bindings.json");
    const source = { ...f.identity, kind: "world", sessionPath: worker, runId: f.root.id, input: { operation: "create_world", text: f.text } };
    await writeFile(path, JSON.stringify({ version: 1, bindings: { [f.root.requestId]: source } })); await service.initialize();
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: f.identity.creationSessionId,
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49999/", token: "a".repeat(64) }));
    const token = await service.register(f.identity.playerId, f.home, worker), client = service.client("Bearer " + token)!;
    (service as any).productionRecovery = async () => { if (rejectProof) throw new Error("proof_rejected"); return f.grant(); };
    const input = { operation: "create_world" as const, text: f.text, previousRequestId: f.root.requestId }, requestId = randomUUID();
    const before = await readFile(path);
    await assert.rejects(service.submit(client, requestId, input), /proof_rejected/); assert.deepEqual(await readFile(path), before);
    assert.equal(started.size, 0); rejectProof = false;
    const commit = (service as any).commit.bind(service); (service as any).commit = async () => { throw new Error("commit_failed"); };
    await assert.rejects(service.submit(client, requestId, input), /commit_failed/); assert.deepEqual(await readFile(path), before);
    assert.equal(started.size, 0); (service as any).commit = commit;
    await assert.rejects(service.submit(client, requestId, input), /response_lost/);
    assert.equal(started.size, 1);
    const restarted = new VeyaCreatorService(directory, flow as never); await restarted.initialize();
    (restarted as any).productionRecovery = async () => f.grant();
    const outcomes = await Promise.allSettled([restarted.submit(client, requestId, input), restarted.submit(client, randomUUID(), input)]);
    assert.equal(outcomes[0]!.status, "fulfilled"); assert.equal(outcomes[1]!.status, "rejected"); assert.equal(started.size, 1);
    const saved = JSON.parse(await readFile(path, "utf8")), binding = saved.bindings[requestId];
    assert.equal((await readProductionGrant(directory, binding.worldProductionRecoveryRef)).recovery.nextRound, 3);
    saved.bindings[randomUUID()] = { ...binding, runId: randomUUID() }; await writeFile(path, JSON.stringify(saved));
    await assert.rejects(new VeyaCreatorService(directory, flow as never).initialize(), /production_round_already_claimed/);
    delete saved.bindings[Object.keys(saved.bindings).find(k => k !== f.root.requestId && k !== requestId)!];
    await writeFile(path, JSON.stringify(saved));
    await rm(join(directory, ".aura/veya-creator/grants", binding.worldProductionRecoveryRef.grantId + ".json"));
    const missingBefore = await readFile(path);
    await assert.rejects(new VeyaCreatorService(directory, flow as never).initialize(), /production_grant_invalid/);
    assert.deepEqual(await readFile(path), missingBefore, "a missing grant must not turn an existing index into an empty project");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
