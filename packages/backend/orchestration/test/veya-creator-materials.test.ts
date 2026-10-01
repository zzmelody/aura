import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { VeyaCreatorBindings, VeyaCreatorCapability, CREATOR_REQUIRED_TOOLS, CREATOR_REQUIRED_VERIFICATION, VEYA_CREATOR_CAPABILITY } from "../src/veya-creator-bindings.ts";
import { productionDigest } from "../src/veya-creator-production-grants.ts";
import { writeMaterialsGrant, materialSubmissionFingerprint, type MaterialsGrant } from "../src/veya-creator-materials.ts";

test("new task material context inherits only pinned resources and blocks completed operations on its bound worker", async t => {
  const root = await mkdtemp(join(tmpdir(), "aura-material-binding-")); t.after(() => rm(root, { recursive: true, force: true }));
  const sourceId = randomUUID(), sourceRun = randomUUID(), requestId = randomUUID(), runId = randomUUID(), childId = randomUUID();
  const session = "a".repeat(32), home = "b".repeat(32), workerPath = join(root, "worker.json"), model = "c".repeat(64), moduleId = "d".repeat(64);
  const identity = { playerId: "player", homeWorldId: home, creationSessionId: session, textHash: createHash("sha256").update("courtyard").digest("hex"), requestTextHash: createHash("sha256").update("courtyard").digest("hex") };
  const spec = { id: "plaque" }, atmosphere = { presetId: "blue_hour", seed: 1, source: "procedural", cloudAmount: 0, cloudScale: 1, haze: 0, warmth: 0, brightness: 0 };
  const grant: MaterialsGrant = { version: 1, identity, materials: { schemaVersion: 1, sourceRequestId: sourceId, sourceRunId: sourceRun,
    sourceBrief: { operation: "create_world" }, sourcePlan: {}, sourceGameplaySpec: {}, sourceExhaustedRound: 3, validation: "unverified", noNewPaidWork: true,
    common: { status: "ready" }, props: [{ status: "ready", spec, specHash: productionDigest(spec), module: { kind: "prop", module_id: moduleId, content_hash: moduleId }, preparation: { receiptHash: "e".repeat(64) } }] },
    proof: { assets: [{ assetId: "model", contentHash: model }], modules: [{ moduleId, contentHash: moduleId }], completedOperations: [
      { operation: "veya.cooker.submit", operationId: "cook_prop", fingerprint: materialSubmissionFingerprint("veya.cooker.submit", { pipelineSource: "return {}" }) },
      { operation: "veya.atmosphere.build", operationId: "cook_sky", fingerprint: materialSubmissionFingerprint("veya.atmosphere.build", atmosphere) }] } };
  const ref = await writeMaterialsGrant(root, grant); await writeFile(workerPath, JSON.stringify({ role: "creator-worker", creation_session_id: session }));
  const source = { ...identity, runId: sourceRun, sessionPath: workerPath, input: { operation: "create_world", text: "courtyard" } };
  const records = { version: 1, bindings: { [sourceId]: source, [requestId]: { ...source, runId,
    input: { operation: "create_world", text: "courtyard", reuseProductionFromRequestId: sourceId }, productionMaterialsRef: ref, recoveryBudgetCreationId: sourceId } } };
  const bindingPath = join(root, ".aura/veya-creator/bindings.json"); await writeFile(bindingPath, JSON.stringify(records));
  const run = { id: runId, requestId, flow: { id: "veya/veya-wish" }, steps: [] } as unknown as FlowRun;
  const sourceHistory = { id: sourceRun, requestId: sourceId, status: "completed", flow: { id: "veya/veya-wish" }, steps: [] } as unknown as FlowRun;
  const child = { id: childId, requestId: randomUUID(), flow: { id: "veya/veya-world-agent" }, parent: { runId } } as unknown as FlowRun;
  const get = (id: string) => id === runId ? run : id === sourceRun ? sourceHistory : child, bindings = new VeyaCreatorBindings(root), calls: string[] = [];
  const creator = new VeyaCreatorCapability(bindings, get, { async invoke(_cap, op, _input, _signal, context) {
    assert.equal(await bindings.resolve(context!.runId!, get), workerPath); calls.push(op);
    if (op === "veya.system.context") return { tools: CREATOR_REQUIRED_TOOLS.map(name => ({ name })), system: { creation_verification: Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(name => [name, 1])) } };
    if (op === "veya.world.status") return { profile: { home_world_id: home } };
    if (op === "veya.assets.list") return { model: { content_hash: model } };
    assert.equal(op, "veya.creation.module.read"); return { kind: "prop", module_id: moduleId, content_hash: moduleId, assets: [{ asset_id: "model", content_hash: model }] };
  } });
  const output = await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, new AbortController().signal, { runId: childId }) as any;
  assert.deepEqual(output.productionMaterials, grant.materials); assert.equal(output.worldProductionRecovery, undefined); assert.equal(output.assetReuse, undefined);
  assert.deepEqual(calls, ["veya.system.context", "veya.world.status", "veya.assets.list", "veya.creation.module.read"]);
  await assert.rejects(bindings.resolve(childId, get, "veya.cooker.submit", { pipeline_source: "return {}", request_id: "different", timeout_seconds: 5 }), /completed_operation_reuse_required/);
  await assert.rejects(bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, request_id: "different" }), /completed_operation_reuse_required/);
  const expected_sources = { schema_version: 1, shader_sha256: "1".repeat(64), recipe_sha256: "2".repeat(64), template_sha256: "3".repeat(64) };
  // Only the exact registered session receives this call; native performs the
  // packaged-source check before cooking. No default descriptor is consulted.
  assert.equal(await bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, expected_sources }), workerPath);
  await assert.rejects(bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, expected_sources: { ...expected_sources, random: "bypass" } }), /invalid_atmosphere_sources/);
  await writeFile(workerPath, JSON.stringify({ role: "creator-worker", creation_session_id: "f".repeat(32) }));
  await assert.rejects(bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, expected_sources }), /creator_worker_binding_mismatch/);
  await writeFile(workerPath, JSON.stringify({ role: "creator-worker", creation_session_id: session }));
  const upgradedGrant = structuredClone(grant);
  upgradedGrant.proof.completedOperations.push({ operation: "veya.atmosphere.build", operationId: "cook_new_shader",
    fingerprint: materialSubmissionFingerprint("veya.atmosphere.build", { ...atmosphere, expected_sources }) });
  records.bindings[requestId]!.productionMaterialsRef = await writeMaterialsGrant(root, upgradedGrant);
  await writeFile(bindingPath, JSON.stringify(records));
  await assert.rejects(bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, expected_sources, request_id: "replay" }), /completed_operation_reuse_required: cook_new_shader/);
  await assert.rejects(bindings.resolve(childId, get, "veya.atmosphere.build", { ...atmosphere, request_id: "legacy" }), /completed_operation_reuse_required: cook_sky/);
  assert.equal(await bindings.resolve(childId, get, "veya.cooker.submit", { pipeline_source: "return {changed=true}" }), workerPath);
  assert.equal((await bindings.binding(childId, get))!.record.materialsGrant!.materials.noNewPaidWork, true);
  (records.bindings[requestId]!.input as any).previousRequestId = sourceId; await writeFile(bindingPath, JSON.stringify(records));
  await assert.rejects(bindings.resolve(childId, get), /creator_production_materials_unavailable/);
});
