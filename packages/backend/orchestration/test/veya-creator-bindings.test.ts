import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { VeyaCreatorBindings, VeyaCreatorCapability, VEYA_CREATOR_CAPABILITY, CREATOR_REQUIRED_TOOLS, CREATOR_REQUIRED_VERIFICATION } from "../src/veya-creator-bindings.ts";
import { VEYA_WORLD_AGENT_CAPABILITY, VeyaWorldAgentCapability } from "../src/veya-world-agent.ts";

test("creator child actions use their worker while ordinary Veya actions keep the foreground session", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-binding-"));
  const foreground = join(root, "foreground.json"), worker = join(root, "worker.json");
  const parentId = randomUUID(), childId = randomUUID(), requestId = randomUUID();
  try {
    await mkdir(join(root, ".aura", "veya-creator"), { recursive: true });
    await writeFile(foreground, JSON.stringify({ protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49111/", token: "a".repeat(64) }));
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "c".repeat(32), protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49222/", token: "b".repeat(64) }));
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: { [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker,
        homeWorldId: "home", input: { operation: "update_layout", targetWorldId: "my_world", target: { worldId: "my_world", baseRevision: 3, allowedEntityIds: ["tower"], allowSpawnChange: false } } } } }));
    const runs = new Map<string, FlowRun>([
      [parentId, { id: parentId, requestId, flow: { id: "veya/veya-wish" } } as FlowRun],
      [childId, { id: childId, requestId: randomUUID(), parent: { runId: parentId, stepKey: "main/build" },
        flow: { id: "veya/veya-world-agent" } } as FlowRun],
    ]);
    const binding = new VeyaCreatorBindings(root);
    const seen: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true, data: { worlds: [] } }));
    }) as typeof fetch;
    const capability = new VeyaWorldAgentCapability(foreground, fakeFetch);
    capability.setRunSessionResolver((id, operation, input) => binding.resolve(id, (key) => runs.get(key)!, operation, input));
    const signal = new AbortController().signal;
    let toolNames: readonly string[] = CREATOR_REQUIRED_TOOLS;
    let verification: JsonValue = Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(name => [name, 1]));
    const creator = new VeyaCreatorCapability(binding, id => runs.get(id)!, {
      async invoke(cap, operation, input, _signal, context) {
        assert.equal(cap, VEYA_WORLD_AGENT_CAPABILITY); assert.equal(operation, "veya.system.context");
        assert.deepEqual(input, {}); assert.equal(context?.runId, childId);
        return { tools: toolNames.map(name => ({ name })), system: { creation_verification: verification } };
      },
    });
    assert.deepEqual(await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId }), {
      schemaVersion: 1, creationId: requestId, homeWorldId: "home", operation: "update_layout", targetWorldId: "my_world",
      target: { worldId: "my_world", baseRevision: 3, allowedEntityIds: ["tower"], allowSpawnChange: false },
      budget: { maxAiAssets: 6, maxCharacters: 2, maxRepairRounds: 3, maxSkyImages: 0 },
      worker: { role: "creator-worker", platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "unknown" },
    });
    await assert.rejects(creator.invoke(VEYA_CREATOR_CAPABILITY, "context", { runId: parentId }, signal, { runId: childId }), /unavailable/u);
    toolNames = CREATOR_REQUIRED_TOOLS.filter(name => name !== "veya.playtest.save_resume");
    await assert.rejects(creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId }),
      /creator_worker_upgrade_required: veya.playtest.save_resume/u);
    toolNames = [];
    await assert.rejects(creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId }), /creator_worker_upgrade_required/u);
    toolNames = CREATOR_REQUIRED_TOOLS;
    // Tool names alone cannot establish saved-progress, geometry or native authored identities.
    for (const bad of [null, {}, ...CREATOR_REQUIRED_VERIFICATION.flatMap(name => [
      { ...Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.filter(key => key !== name).map(key => [key, 1])) },
      ...[0, -1, "1", 1.5, true].map(value => ({ ...Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(key => [key, 1])), [name]: value })),
    ])]) {
      verification = bad;
      await assert.rejects(creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId }),
        /creator_worker_upgrade_required: creation_verification\./u);
    }
    verification = Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(name => [name, 2]));
    await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId });
    verification = Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(name => [name, 1]));
    await capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.world.list", {}, signal);
    await capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.world.list", {}, signal, { runId: childId });
    assert.deepEqual(seen, ["http://127.0.0.1:49111/v2/worlds/list", "http://127.0.0.1:49222/v2/worlds/list"]);
    const artifact = "d".repeat(64), candidate = "e".repeat(64);
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: { [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker, homeWorldId: "home",
        previousArtifact: { artifactId: artifact, candidateHash: candidate, kind: "world" },
        input: { operation: "update_layout", previousArtifactId: artifact,
          artifactTarget: { allowedEntityIds: ["tower"], allowSpawnChange: false } } } } }));
    const linked = await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId }) as Record<string, unknown>;
    assert.deepEqual(linked.previousArtifact, { artifactId: artifact, candidateHash: candidate, kind: "world" });
    assert.deepEqual(linked.artifactTarget, { allowedEntityIds: ["tower"], allowSpawnChange: false });
    const checkout = { artifact_id: artifact, content_hash: artifact, mode: "overlay", request_id: randomUUID() };
    assert.equal(await binding.resolve(childId, key => runs.get(key)!, "veya.creation.checkout", checkout), worker);
    for (const bad of [{ ...checkout, artifact_id: candidate }, { ...checkout, content_hash: candidate }, { ...checkout, mode: "recompose" }])
      await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.creation.checkout", bad, signal,
        { runId: childId }), /creator_artifact_binding_mismatch/u);
    await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.creation.checkout", checkout, signal), /creator_artifact_binding_mismatch/u);
    assert.equal(seen.length, 2, "rejected checkout never reaches the worker");
    const savedTarget = { worldId: "saved_world", baseRevision: 9, baseHash: "f".repeat(64), allowedEntityIds: ["tower"], allowSpawnChange: false };
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: { [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker, homeWorldId: "home",
        previousArtifact: { artifactId: artifact, candidateHash: candidate, kind: "world" },
        input: { operation: "update_environment", previousArtifactId: artifact, targetWorldId: savedTarget.worldId, target: savedTarget } } } }));
    const savedContext = await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId }) as Record<string, unknown>;
    assert.deepEqual(savedContext.target, savedTarget);
    assert.deepEqual(savedContext.artifactTarget, { allowedEntityIds: savedTarget.allowedEntityIds, allowSpawnChange: false });
    const readLineage = { world_id: savedTarget.worldId, artifact_id: artifact, artifact_content_hash: artifact,
      expected_revision: savedTarget.baseRevision, expected_content_hash: savedTarget.baseHash };
    assert.equal(await binding.resolve(childId, key => runs.get(key)!, "veya.world.read", readLineage), worker);
    await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.world.read", readLineage, signal),
      /creator_artifact_binding_mismatch/u, "artifact-aware reads cannot bypass the trusted Run through the default session");
    for (const bad of [{ ...readLineage, artifact_id: candidate }, { ...readLineage, artifact_content_hash: candidate },
      { ...readLineage, world_id: "unowned" }, { ...readLineage, expected_revision: 1 },
      { ...readLineage, expected_content_hash: candidate }, { world_id: savedTarget.worldId, artifact_id: artifact }])
      await assert.rejects(binding.resolve(childId, key => runs.get(key)!, "veya.world.read", bad), /creator_artifact_binding_mismatch/u);
    await assert.rejects(binding.resolve(childId, key => runs.get(key)!, "veya.creation.checkout", checkout), /creator_artifact_binding_mismatch/u,
      "editing the existing progress world cannot create a replacement checkout");
    assert.equal(seen.length, 2, "binding validation causes no native side effects");
    const worldDesignRecovery = { schemaVersion: 1, sourceRequestId: randomUUID(), sourceRunId: randomUUID(),
      brief: { operation: "create_world" }, plan: { targetWorldId: "creation-template" }, designInput: { scope: "world" },
      draftText: '{"x":[1}]}', draftHash: "a".repeat(64), formatCorrectionUsed: false };
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1, bindings: {
      [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker, homeWorldId: "home",
        input: { operation: "create_world" }, worldDesignRecovery },
    } }));
    const designContext = await creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: childId }) as Record<string, unknown>;
    assert.deepEqual(designContext.worldDesignRecovery, worldDesignRecovery);
    assert.equal(designContext.recovery, undefined, "world syntax recovery never masquerades as paid prop recovery");
    assert.equal(JSON.stringify(designContext).includes(worker), false, "context contains no native descriptor path");
    await assert.rejects(creator.invoke(VEYA_CREATOR_CAPABILITY, "context", { worldDesignRecovery }, signal, { runId: childId }), /creator_context_unavailable/u);
    const preparedSubmission = { pipelineSource: "return {}", sources: [{ path: "content/scripts/cooker/a.luau", source: "return {}" }],
      inputs: [{ source: "res://assets/raw.scn", destination: "assets/raw.scn" }], timeoutSeconds: 300 };
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: { [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker, homeWorldId: "home",
        recovery: { preparedOperation: { operationId: "cook_completed", submission: preparedSubmission } } } } }));
    const repeatedCook = { request_id: randomUUID(), pipeline_source: preparedSubmission.pipelineSource,
      sources: preparedSubmission.sources, inputs: [{ destination: "assets/raw.scn", source: "res://assets/raw.scn" }], timeout_seconds: 120 };
    await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.cooker.submit", repeatedCook, signal, { runId: childId }),
      /creator_prepared_operation_reuse_required: cook_completed/u);
    assert.equal(seen.length, 2, "new request identity or timeout cannot repeat an already completed preparation");
    assert.equal(await binding.resolve(childId, key => runs.get(key)!, "veya.cooker.submit", { ...repeatedCook,
      sources: [{ path: "content/scripts/cooker/a.luau", source: "return corrected_recipe" }] }), worker,
      "an actual changed recipe remains subject to the normal bounded content repair path");
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1, bindings: {
      [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker, homeWorldId: "home",
        recovery: { preparedOperation: { operationId: "cook_corrected", submission: { ...preparedSubmission, pipelineSource: "return corrected" } } } },
      [randomUUID()]: { creationSessionId: "c".repeat(32), sessionPath: worker, recoveryBudgetCreationId: requestId,
        recovery: { preparedOperation: { operationId: "cook_completed", submission: preparedSubmission } } },
    } }));
    await assert.rejects(binding.resolve(childId, key => runs.get(key)!, "veya.cooker.submit", repeatedCook),
      /creator_prepared_operation_reuse_required: cook_completed/u,
      "a corrected preparation retains duplicate protection for older completed recipes in the same paid-work lineage");
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: { [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker, runId: randomUUID() } } }));
    await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.world.list", {}, signal,
      { runId: childId }), /creator_worker_binding_mismatch/u);
    assert.equal(seen.length, 2);
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: { [requestId]: { creationSessionId: "c".repeat(32), sessionPath: foreground, runId: parentId } } }));
    await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.world.list", {}, signal,
      { runId: childId }), /creator worker descriptor is invalid/u);
    assert.equal(seen.length, 2);
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: { [requestId]: { creationSessionId: "c".repeat(32), sessionPath: worker, runId: parentId } } }));
    await writeFile(worker, JSON.stringify({ protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49111/", token: "a".repeat(64) }));
    await assert.rejects(capability.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.world.list", {}, signal,
      { runId: childId }), /creator worker descriptor is invalid/u);
    assert.equal(seen.length, 2);
  } finally {
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
    await rm(root, { recursive: true, force: true });
  }
});

test("creator version admission probes only its bound worker and rejects tool-compatible old builds before production", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-version-"));
  const foreground = join(root, "foreground.json"), worker = join(root, "worker.json");
  const runId = randomUUID(), requestId = randomUUID();
  const run = { id: runId, requestId, flow: { id: "veya/veya-wish" } } as FlowRun;
  const oldThree = { progress_projection: 1, creation_geometry: 1, stable_interaction_ids: 1 };
  const current = { ...oldThree, authored_identities: 1 };
  let advertised: JsonValue = null;
  const requests: string[] = [];
  try {
    await mkdir(join(root, ".aura", "veya-creator"), { recursive: true });
    const descriptor = { protocol: "veya-world-http/1", tools_protocol: "veya-agent-tools/1", token: "a".repeat(64) };
    await writeFile(foreground, JSON.stringify({ ...descriptor, base_url: "http://127.0.0.1:49111/" }));
    await writeFile(worker, JSON.stringify({ ...descriptor, role: "creator-worker", creation_session_id: "b".repeat(32),
      base_url: "http://127.0.0.1:49222/" }));
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1, bindings: {
      [requestId]: { sessionPath: worker, runId, creationSessionId: "b".repeat(32), homeWorldId: "home" },
    } }));
    const binding = new VeyaCreatorBindings(root);
    const client = new VeyaWorldAgentCapability(foreground, async (url, init) => {
      requests.push(String(url));
      assert.deepEqual(JSON.parse(String(init?.body)), { tool: "veya.system.context", arguments: {} });
      return new Response(JSON.stringify({ ok: true, data: { tools: CREATOR_REQUIRED_TOOLS.map(name => ({ name })),
        system: { creation_verification: advertised } } }));
    });
    client.setRunSessionResolver((id, operation, input) => binding.resolve(id, () => run, operation, input));
    const creator = new VeyaCreatorCapability(binding, () => run, client);
    const invoke = () => creator.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, new AbortController().signal, { runId });
    // Regression: the previous three-version worker exposed world.read but omitted
    // native authored IDs. The prior mocked capability test did not exercise its
    // real Run-bound transport, and paid production must not reach that old build.
    const rejectedVersions = [null, { ...current, progress_projection: 0 }, { ...current, creation_geometry: 0 },
      { ...current, stable_interaction_ids: 0 }, oldThree,
      ...[0, -1, "1", 1.5, true].map(authored_identities => ({ ...current, authored_identities }))];
    for (const version of rejectedVersions) {
      advertised = version;
      await assert.rejects(invoke(), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^creator_worker_upgrade_required: creation_verification\./u);
        assert.equal(error.message.includes("127.0.0.1"), false);
        assert.equal(error.message.includes(descriptor.token), false);
        if (version === oldThree) assert.equal(error.message, "creator_worker_upgrade_required: creation_verification.authored_identities");
        return true;
      });
    }
    advertised = current;
    await invoke();
    assert.deepEqual(requests, Array(rejectedVersions.length + 1).fill("http://127.0.0.1:49222/agent/v1/call"),
      "rejected admission has no paid/native write and never probes the foreground default");
  } finally {
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
    await rm(root, { recursive: true, force: true });
  }
});
