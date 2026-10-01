import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { VeyaCreatorBindings, VeyaCreatorCapability, CREATOR_REQUIRED_TOOLS, CREATOR_REQUIRED_VERIFICATION, VEYA_CREATOR_CAPABILITY } from "../src/veya-creator-bindings.ts";
import { productionDigest, productionRecoveryBoundary, validatePendingProductionClaims, writeProductionGrant, cookerSubmissionFingerprint, type ProductionGrant } from "../src/veya-creator-production-grants.ts";
import { materialSubmissionFingerprint } from "../src/veya-creator-materials.ts";

test("production context admits a bound worker once, child context follows its durable receipt, completed Cooker cannot resubmit", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-production-binding-"));
  try {
    const worker = join(root, "worker.json"), session = "a".repeat(32), worldId = "b".repeat(32), owner = "c".repeat(32), home = "d".repeat(32);
    const sourceId = randomUUID(), sourceRun = randomUUID(), requestId = randomUUID(), rootId = randomUUID(), childId = randomUUID();
    const identity = { playerId: "player", homeWorldId: home, creationSessionId: session, textHash: createHash("sha256").update("courtyard").digest("hex") };
    const draft = { draft_id: "e".repeat(32), draft_revision: 1, world_id: worldId, base_revision: 1, content_hash: "f".repeat(64), assets: [], asset_versions: {} };
    const resume = { worldId, draft, round: 0 };
    const atmosphere = { presetId: "blue_hour", seed: 17, source: "procedural" };
    const grant: ProductionGrant = { version: 1, identity, recovery: { schemaVersion: 1, sourceRequestId: sourceId, sourceRunId: sourceRun,
      brief: { operation: "create_world" }, continuation: [], resume, resumeHash: productionDigest(resume), noNewPaidWork: true, nextRound: 1 },
      proof: { world: { worldId, ownerId: owner, revision: 1, contentHash: "9".repeat(64) }, draft: structuredClone(draft), assets: [], modules: [],
        completedOperations: [{ operationId: "cook_done", fingerprint: cookerSubmissionFingerprint({ pipelineSource: "return {}" }) },
          { operation: "veya.atmosphere.build", operationId: "atmosphere_done", fingerprint: materialSubmissionFingerprint("veya.atmosphere.build", atmosphere) }] } };
    const ref = await writeProductionGrant(root, grant);
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: session }));
    const source = { ...identity, runId: sourceRun, sessionPath: worker, input: { operation: "create_world", text: "courtyard" } };
    await writeFile(join(root, ".aura/veya-creator/bindings.json"), JSON.stringify({ version: 1, bindings: {
      [sourceId]: source, [requestId]: { ...source, runId: rootId, input: { operation: "create_world", text: "courtyard", previousRequestId: sourceId },
        recoveryBudgetCreationId: sourceId, worldProductionRecoveryRef: ref },
    } }));
    const run = { id: rootId, requestId, flow: { id: "veya/veya-wish" }, steps: [] } as unknown as FlowRun;
    const child = { id: childId, requestId: randomUUID(), flow: { id: "veya/veya-world-agent" }, parent: { runId: rootId } } as unknown as FlowRun;
    const get = (id: string) => id === rootId ? run : child, bindings = new VeyaCreatorBindings(root);
    const calls: string[] = [];
    const creator = new VeyaCreatorCapability(bindings, get, { async invoke(_cap, op, _input, _signal, context) {
      assert.equal(await bindings.resolve(context!.runId!, get), worker); calls.push(op);
      if (op === "veya.system.context") return { tools: CREATOR_REQUIRED_TOOLS.map(name => ({ name })), system: { creation_verification: Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(name => [name, 1])) } };
      if (op === "veya.world.status") return { playtest_id: "", profile: { player_id: owner, home_world_id: home } };
      if (op === "veya.world.read") return { revision: 1, content_hash: "9".repeat(64), manifest: { world_id: worldId, revision: 1, owner_id: owner } };
      if (op === "veya.draft.read") return draft;
      assert.equal(op, "veya.assets.list"); return {};
    } });
    const signal = new AbortController().signal;
    const projected = await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: rootId }) as any;
    assert.deepEqual(projected.worldProductionRecovery, grant.recovery); assert.equal(projected.productionGrant, undefined);
    assert.equal(projected.assetReuse, undefined); assert.equal(projected.worldDesignRecovery, undefined);
    assert.equal(calls.length, 5);
    run.steps.push({ id: "context", kind: "action", actionId: "veya/creator-context", status: "completed", output: projected } as never);
    draft.draft_revision = 2; // A valid compose within this same root Run.
    await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId });
    assert.equal(calls.length, 6, "only the capability-version probe repeats, not old draft admission");
    const hydrated = await bindings.binding(childId, get); assert.equal(hydrated!.record.productionGrant!.recovery.noNewPaidWork, true);
    await assert.rejects(bindings.resolve(childId, get, "veya.cooker.submit", { pipeline_source: "return {}", request_id: "new", timeout_seconds: 1 }), /creator_completed_operation_reuse_required/);
    assert.equal(await bindings.resolve(childId, get, "veya.cooker.submit", { pipeline_source: "return {changed=true}" }), worker);
    await assert.rejects(bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, request_id: "new" }), /creator_completed_operation_reuse_required: atmosphere_done/);
    assert.equal(await bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, haze: .4 }), worker);
    await writeFile(join(root, ".aura/veya-creator/grants", ref.grantId + ".json"), "{}");
    await assert.rejects(bindings.resolve(childId, get), /creator_production_recovery_unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker binding refuses two successors of the same host-proven unstarted round", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-production-claim-binding-"));
  try {
    const sourceId = randomUUID(), sourceRunId = randomUUID(), requestId = randomUUID(), runId = randomUUID();
    const sessionPath = join(root, "worker.json"), home = "a".repeat(32), worldId = "b".repeat(32);
    const identity = { playerId: "player", homeWorldId: home, creationSessionId: "c".repeat(32), textHash: createHash("sha256").update("courtyard").digest("hex") };
    const draft = { draft_id: "d".repeat(32), world_id: worldId, base_revision: 1, draft_revision: 2, content_hash: "e".repeat(64) };
    const build = { gameplaySpec: {} }, resume = { worldId, draft, round: 2, build };
    const grant: ProductionGrant = { version: 1, identity, recovery: { schemaVersion: 1, sourceRequestId: sourceId, sourceRunId,
      brief: { operation: "create_world" }, continuation: [], resume, resumeHash: productionDigest(resume), nextRound: 3, noNewPaidWork: true },
      proof: { world: { worldId, ownerId: "f".repeat(32), revision: 1, contentHash: "0".repeat(64) }, draft, assets: [], modules: [], completedOperations: [],
        pendingRound: { schemaVersion: 1, round: 3, worldRunId: randomUUID(), completedBuildRunId: randomUUID(), blockedBuildRunId: randomUUID(), environmentRunId: randomUUID(),
          finalResumeHash: "1".repeat(64), completedOutputHash: productionDigest(build), blockedInputHash: "2".repeat(64), resolvedSpecHash: productionDigest(build.gameplaySpec) } } };
    const ref = await writeProductionGrant(root, grant), source = { ...identity, runId: sourceRunId, sessionPath, input: { operation: "create_world", text: "courtyard" } };
    const record = { ...source, runId, worldProductionRecoveryRef: ref, recoveryBudgetCreationId: sourceId, input: { ...source.input, previousRequestId: sourceId } };
    const index = { version: 1, bindings: { [sourceId]: source, [requestId]: record } };
    const path = join(root, ".aura/veya-creator/bindings.json"); await writeFile(path, JSON.stringify(index));
    const run = { id: runId, requestId, flow: { id: "veya/veya-wish" }, steps: [] } as unknown as FlowRun;
    const binding = new VeyaCreatorBindings(root);
    assert.ok(await binding.binding(runId, () => run, false));
    index.bindings[randomUUID()] = { ...record, runId: randomUUID() }; await writeFile(path, JSON.stringify(index));
    await assert.rejects(binding.binding(runId, () => run, false), /creator_production_recovery_unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary recovery boundary claims survive restart, reject duplicates and preserve historical reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-production-ordinary-claims-"));
  try {
    const sourceId = randomUUID(), sourceRunId = randomUUID(), requestId = randomUUID(), runId = randomUUID();
    const sessionPath = join(root, "worker.json"), home = "a".repeat(32), worldId = "b".repeat(32);
    const identity = { playerId: "player", homeWorldId: home, creationSessionId: "c".repeat(32), textHash: createHash("sha256").update("courtyard").digest("hex") };
    const draft = { draft_id: "d".repeat(32), world_id: worldId, base_revision: 1, draft_revision: 2, content_hash: "e".repeat(64) };
    const resume = { worldId, draft, round: 2 };
    const grant: ProductionGrant = { version: 1, identity, recovery: { schemaVersion: 1, sourceRequestId: sourceId, sourceRunId,
      brief: { operation: "create_world" }, continuation: [], resume, resumeHash: productionDigest(resume), nextRound: 3, noNewPaidWork: true },
      proof: { world: { worldId, ownerId: "f".repeat(32), revision: 1, contentHash: "0".repeat(64) }, draft, assets: [], modules: [], completedOperations: [] } };
    const ref = await writeProductionGrant(root, grant), source = { ...identity, runId: sourceRunId, sessionPath, input: { operation: "create_world", text: "courtyard" } };
    const legacy = { ...source, runId, worldProductionRecoveryRef: ref, recoveryBudgetCreationId: sourceId, input: { ...source.input, previousRequestId: sourceId } };
    const claimed = { ...legacy, productionRecoveryClaimVersion: 1, productionRecoveryClaim: productionRecoveryBoundary(grant) };
    const path = join(root, ".aura/veya-creator/bindings.json"), run = { id: runId, requestId, flow: { id: "veya/veya-wish" }, steps: [] } as unknown as FlowRun;
    const index = { version: 1, bindings: { [sourceId]: source, [requestId]: claimed } };
    await writeFile(path, JSON.stringify(index));
    for (let i = 0; i < 2; i++) assert.ok(await new VeyaCreatorBindings(root).binding(runId, () => run, false));
    for (const change of [
      (b: any) => { delete b.productionRecoveryClaim; },
      (b: any) => { delete b.productionRecoveryClaimVersion; },
      (b: any) => { b.productionRecoveryClaimVersion = 2; },
      (b: any) => { b.productionRecoveryClaim = "9".repeat(64); },
      (b: any) => { delete b.worldProductionRecoveryRef; },
      (b: any) => { b.input.text = "different content"; },
    ]) {
      const changed = structuredClone(index); change(changed.bindings[requestId]);
      await assert.rejects(() => validatePendingProductionClaims(root, changed.bindings));
    }
    const duplicate = { ...index.bindings, [randomUUID()]: { ...legacy, runId: randomUUID() } };
    await assert.rejects(() => validatePendingProductionClaims(root, duplicate), /production_round_already_claimed/);
    await writeFile(path, JSON.stringify({ version: 1, bindings: duplicate }));
    await assert.rejects(new VeyaCreatorBindings(root).binding(runId, () => run, false), /creator_production_recovery_unavailable/);
    // Earlier capacity-failed and executed successors remain immutable history.
    const historical = { [sourceId]: source, [requestId]: legacy, [randomUUID()]: { ...legacy, runId: randomUUID() } };
    await validatePendingProductionClaims(root, historical);
    await assert.rejects(() => validatePendingProductionClaims(root, { ...historical, [randomUUID()]: claimed }), /production_round_already_claimed/);
    await validatePendingProductionClaims(root, { ...index.bindings, [randomUUID()]: { ...source, input: { operation: "create_world", text: "new work", reuseProductionFromRequestId: sourceId } } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
