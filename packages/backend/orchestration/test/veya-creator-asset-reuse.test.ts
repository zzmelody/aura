import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { VeyaCreatorBindings, VeyaCreatorCapability, CREATOR_REQUIRED_TOOLS, CREATOR_REQUIRED_VERIFICATION, VEYA_CREATOR_CAPABILITY } from "../src/veya-creator-bindings.ts";
import { readAssetReuseGrant, validateInheritedAssetReuseBinding } from "../src/veya-creator-asset-reuse.ts";
import { VeyaWorldAgentCapability } from "../src/veya-world-agent.ts";

// Prior worker-binding tests inspect tool/version availability, not all three
// resource bindings after a worker restart or before returning reuse context.
test("asset reuse reads only its bound catalog, rejects changed resources and never re-cooks identical sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aura-reuse-context-")), worker = join(directory, "worker.json"), foreground = join(directory, "foreground.json");
  const runId = randomUUID(), requestId = randomUUID(), sourceRequestId = randomUUID(), sourceRunId = randomUUID();
  const run = { id: runId, requestId, flow: { id: "veya/veya-wish" } } as FlowRun;
  const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const requirement = { id: "garden", kind: "procedural", description: "Original common courtyard", requiredActions: [] };
  const mesh = "return cooker.mesh({})", scene = "return cooker.scene({})";
  const sourceHash = digest([digest([requirement.id, requirement.description, "", "procedural-v1"]), mesh, scene]);
  const grant = readAssetReuseGrant({ schemaVersion: 1, sourceRequestId, sourceRunId, items: [{ requirement,
    binding: { requirementId: "garden", assetId: "visual", version: "a".repeat(64), collisionAssetId: "collision", collisionVersion: "b".repeat(64),
      navigationAssetId: "nav", navigationVersion: "c".repeat(64), source: "procedural" },
    producer: { runId: randomUUID(), operationId: "cook_" + "1".repeat(32), sourceHash } }] });
  const original = Object.fromEntries(["visual", "collision", "navigation"].map((role, i) => {
    const id = ["visual", "collision", "nav"][i]!;
    return [id, { id, content_hash: ["a", "b", "c"][i]!.repeat(64), type: i === 2 ? "navigation" : "model",
      source_asset_id: `proc_${sourceHash.slice(0, 40)}_${role}`, local_generated: true }];
  }));
  let catalog = structuredClone(original);
  const seen: Array<{ url: string; tool: string }> = [];
  try {
    await mkdir(join(directory, ".aura/veya-creator"), { recursive: true });
    await writeFile(worker, JSON.stringify({ protocol: "veya-world-http/1", tools_protocol: "veya-agent-tools/1", role: "creator-worker",
      creation_session_id: "e".repeat(32), base_url: "http://127.0.0.1:49222/", token: "f".repeat(64) }));
    await writeFile(foreground, JSON.stringify({ protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49111/", token: "f".repeat(64) }));
    const bound = { sessionPath: worker, runId, playerId: "player", creationSessionId: "e".repeat(32), homeWorldId: "home",
      input: { operation: "create_world", text: "original", reuseAssetsFromRequestId: sourceRequestId }, assetReuse: grant };
    const sourceBinding = { sessionPath: worker, runId: sourceRunId, playerId: "player", creationSessionId: "e".repeat(32), homeWorldId: "home",
      input: { operation: "create_world", text: "original" } };
    const sourceRun = { id: sourceRunId, requestId: sourceRequestId, status: "completed", flow: { id: "veya/veya-wish" }, steps: [] } as unknown as FlowRun;
    const get = (id: string) => id === sourceRunId ? sourceRun : run;
    const save = (record: object) => writeFile(join(directory, ".aura/veya-creator/bindings.json"), JSON.stringify({ version: 1, bindings: { [requestId]: record, [sourceRequestId]: sourceBinding } }));
    await save(bound);
    const bindings = new VeyaCreatorBindings(directory);
    const client = new VeyaWorldAgentCapability(foreground, async (url, init) => {
      const body = JSON.parse(String(init?.body)); seen.push({ url: String(url), tool: body.tool });
      assert.deepEqual(body.arguments, {});
      assert.ok(["veya.system.context", "veya.assets.list"].includes(body.tool));
      return new Response(JSON.stringify({ ok: true, data: body.tool === "veya.assets.list" ? catalog : {
        tools: CREATOR_REQUIRED_TOOLS.map(name => ({ name })), system: { creation_verification: Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(k => [k, 1])) },
      } }));
    });
    client.setRunSessionResolver((id, operation, input) => bindings.resolve(id, () => run, operation, input));
    const creator = new VeyaCreatorCapability(bindings, get, client), signal = new AbortController().signal;
    const invoke = () => creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId });
    const context = await invoke() as Record<string, unknown>;
    assert.deepEqual(context.assetReuse, grant); assert.equal(context.recovery, undefined); assert.equal(context.worldDesignRecovery, undefined);
    assert.equal(JSON.stringify(context).includes(worker), false); assert.equal(JSON.stringify(context).includes("f".repeat(64)), false);
    for (const id of ["visual", "collision", "nav"]) for (const patch of [
      { content_hash: "d".repeat(64) }, { source_asset_id: "other_producer" }, { type: "character" }, { local_generated: false },
    ]) {
      catalog = structuredClone(original); Object.assign(catalog[id]!, patch);
      await assert.rejects(invoke(), /asset_reuse_catalog_mismatch/u);
    }
    catalog = structuredClone(original); delete catalog.nav;
    await assert.rejects(invoke(), /asset_reuse_catalog_mismatch/u);
    assert.ok(seen.every(call => call.url === "http://127.0.0.1:49222/agent/v1/call"));
    assert.equal(seen.filter(call => call.tool === "veya.assets.list").length, 14);
    const count = seen.length;
    const repeated = { request_id: randomUUID(), pipeline_source: "immutable original pipeline", timeout_seconds: 10, sources: [
      { path: "content/scripts/cooker/agent_generated/mesh.luau", source: mesh }, { path: "content/scripts/cooker/agent_generated/scene.luau", source: scene },
    ] };
    await assert.rejects(bindings.resolve(runId, () => run, "veya.cooker.submit", repeated), /creator_completed_asset_reuse_required/u);
    assert.equal(seen.length, count, "identical successful work never reaches Cooker");
    await save({ ...bound, input: { ...bound.input, reuseAssetsFromRequestId: randomUUID() } });
    await assert.rejects(invoke(), /asset_reuse_unavailable/u);
    assert.equal(seen.length, count + 1, "mismatched grant stops after version probe, before catalog/production");
    assert.throws(() => readAssetReuseGrant({ ...grant, costs: {} }), /asset_reuse_unavailable/u);
    assert.throws(() => readAssetReuseGrant({ ...grant, items: [{ ...grant.items[0], requirement: { ...requirement, requiredActions: ["walk"] } }] }), /asset_reuse_unavailable/u);
    // The recovery carries the same trusted grant alongside locked Design input;
    // no client-supplied combined reference can authorize this branch.
    const priorRequestId = randomUUID(), priorRunId = randomUUID();
    const prior = { ...bound, playerId: "player", runId: priorRunId, input: { ...bound.input, text: "original" } };
    const designRecovery = { schemaVersion: 1, sourceRequestId: priorRequestId, sourceRunId: priorRunId, formatCorrectionUsed: false };
    const inherited = { ...bound, playerId: "player", input: { operation: "create_world", text: "original", previousRequestId: priorRequestId },
      worldDesignRecovery: designRecovery, recoveryBudgetCreationId: priorRequestId };
    const saveLinked = (record = inherited, original = prior) => writeFile(join(directory, ".aura/veya-creator/bindings.json"),
      JSON.stringify({ version: 1, bindings: { [requestId]: record, [priorRequestId]: original, [sourceRequestId]: sourceBinding } }));
    catalog = structuredClone(original);
    await saveLinked();
    const recovered = await invoke() as Record<string, unknown>;
    assert.deepEqual(recovered.assetReuse, grant); assert.deepEqual(recovered.worldDesignRecovery, designRecovery);
    catalog.visual!.content_hash = "d".repeat(64);
    await assert.rejects(invoke(), /asset_reuse_catalog_mismatch/u, "inherited resources are still checked against the live bound catalog");
    const beforeRejected = seen.length;
    await saveLinked(inherited, { ...prior, playerId: "another" });
    await assert.rejects(invoke(), /asset_reuse_unavailable/u);
    await saveLinked({ ...inherited, input: { ...inherited.input, reuseAssetsFromRequestId: sourceRequestId } } as typeof inherited);
    await assert.rejects(invoke(), /asset_reuse_unavailable/u);
    await saveLinked({ ...inherited, worldDesignRecovery: { ...designRecovery, formatCorrectionUsed: true } });
    await assert.rejects(invoke(), /asset_reuse_unavailable/u, "used format recovery cannot inherit a second time");
    assert.equal(seen.length, beforeRejected, "invalid source binding never reaches either native instance");
    await saveLinked();
    await assert.rejects(bindings.resolve(runId, () => run, "veya.cooker.submit", repeated), /creator_completed_asset_reuse_required/u);
    const syntaxId = randomUUID(), syntaxRunId = randomUUID();
    const syntax = { ...inherited, runId: syntaxRunId };
    const reviewRecovery = { ...designRecovery, sourceRequestId: syntaxId, sourceRunId: syntaxRunId,
      formatCorrectionUsed: true, semanticRevisionUsed: true, reviewRetryUsed: true,
      retainedSpec: { x: [2] }, specHash: digest({ x: [2] }) };
    const review = { ...inherited, input: { ...inherited.input, previousRequestId: syntaxId }, worldDesignRecovery: reviewRecovery };
    const saveReview = (record: object = review, originalSource: object = prior) => writeFile(join(directory, ".aura/veya-creator/bindings.json"),
      JSON.stringify({ version: 1, bindings: { [requestId]: record, [syntaxId]: syntax, [priorRequestId]: originalSource, [sourceRequestId]: sourceBinding } }));
    catalog = structuredClone(original); await saveReview();
    const reviewed = await invoke() as Record<string, unknown>;
    assert.deepEqual(reviewed.assetReuse, grant); assert.deepEqual(reviewed.worldDesignRecovery, reviewRecovery);
    catalog.nav!.content_hash = "d".repeat(64);
    await assert.rejects(invoke(), /asset_reuse_catalog_mismatch/u, "spent review still checks live resources");
    catalog = structuredClone(original);
    for (const patch of [{ specHash: "a".repeat(64) }, { reviewRetryUsed: false }, { formatCorrectionUsed: false },
      { semanticRevisionUsed: false }, { draftText: "changed" }]) {
      await saveReview({ ...review, worldDesignRecovery: { ...reviewRecovery, ...patch } });
      await assert.rejects(invoke(), /asset_reuse_unavailable/u);
    }
    await saveReview(review, { ...prior, creationSessionId: "f".repeat(32) });
    await assert.rejects(invoke(), /asset_reuse_unavailable/u);
    assert.throws(() => validateInheritedAssetReuseBinding({ ...review, worldDesignRecovery: { ...reviewRecovery,
      sourceRequestId: requestId, sourceRunId: runId }, input: { ...review.input, previousRequestId: requestId } }, review, syntax), /asset_reuse_unavailable/u);
    await saveReview();
    await assert.rejects(bindings.resolve(runId, () => run, "veya.cooker.submit", repeated), /creator_completed_asset_reuse_required/u);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); await rm(directory, { recursive: true, force: true });
  }
});
