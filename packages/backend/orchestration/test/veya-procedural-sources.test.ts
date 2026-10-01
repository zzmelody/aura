import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { collectProceduralSources, projectProceduralSources, readProceduralRefs, verifyProceduralCatalog } from "../src/veya-procedural-sources.ts";
import { VeyaCreatorBindings, VeyaCreatorCapability, VEYA_CREATOR_CAPABILITY, CREATOR_REQUIRED_TOOLS, CREATOR_REQUIRED_VERIFICATION } from "../src/veya-creator-bindings.ts";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

// Existing binding tests cover session routing, not durable recipe provenance:
// a source-hash guess must never permit reading another task's managed source.
function fixture(suffix = "") {
  const root = { id: randomUUID(), requestId: randomUUID(), status: "running", flow: { id: "veya/veya-world-agent" }, steps: [] } as unknown as FlowRun;
  const input = { requirementId: "garden" + suffix, description: "A small garden", revisionHint: "" };
  const mesh = "return function(ctx) return ctx:mesh({}) end\n", scene = "return function(ctx) return ctx:scene({}) end\n";
  const hash = digest(JSON.stringify([digest(JSON.stringify([input.requirementId, input.description, "", "procedural-v1"])), mesh, scene]));
  const operationId = "cook_" + randomUUID().replaceAll("-", "");
  const catalog = Object.fromEntries(["visual", "collision", "navigation"].map((role, i) => {
    const id = "registered_" + role + suffix;
    return [id, { id, content_hash: String(i + 2).repeat(64), type: i === 2 ? "navigation" : "model", local_generated: true,
      source_asset_id: "proc_" + hash.slice(0, 40) + "_" + role }];
  }));
  const output = { schemaVersion: 1, status: "ready", sourceHash: hash, operationId,
    ...Object.fromEntries(["visual", "collision", "navigation"].map(role => [role, { assetId: catalog["registered_" + role + suffix]!.id, version: catalog["registered_" + role + suffix]!.content_hash }])) };
  const producer = { id: randomUUID(), requestId: randomUUID(), status: "completed", flow: { id: "veya/veya-procedural-asset" },
    input, output, parent: { runId: root.id, stepKey: "main/produce" }, steps: [] } as unknown as FlowRun;
  producer.steps = [
    { kind: "agent", id: "author", status: "completed", actions: [{ id: "veya/asset-list", sourceHash: "a".repeat(64) }] },
    { kind: "action", id: "submit", actionId: "veya/cooker-submit", status: "completed", input: { pipelineSource: "return {}", sources: [
      { path: "content/scripts/cooker/agent_generated/mesh.luau", source: mesh },
      { path: "content/scripts/cooker/agent_generated/scene.luau", source: scene }], timeoutSeconds: 300 }, output: { operation_id: operationId, status: "queued" } },
    { kind: "action", id: "wait", actionId: "veya/cooker-status", status: "completed", input: { operationId },
      output: { operation_id: operationId, status: "succeeded", cooker: { ok: true, steps: Array.from({ length: 10 }, () => ({ ok: true, error: 0 })) }, assets: Object.values(catalog) } },
  ] as never;
  root.steps.push({ kind: "flow", id: "produce", status: "completed", stepKey: "main/produce", childRunId: producer.id } as never);
  const runs = new Map([[root.id, root], [producer.id, producer]]);
  const get = (id: string) => { const r = runs.get(id); assert.ok(r, "only reachable fixture runs may be read"); return r; };
  return { root, producer, runs, get, catalog, mesh, scene, input, read: () => collectProceduralSources([{ run: root }], get) };
}

test("procedural source proof binds original UTF-8 recipes, successful Cooker and all three current pins", () => {
  const f = fixture(), [source] = f.read(); assert.ok(source);
  assert.equal(source.meshRecipe.source, f.mesh); assert.equal(source.meshRecipe.sha256, digest(f.mesh));
  assert.equal(source.sceneRecipe.source, f.scene); assert.equal(source.sceneRecipe.sha256, digest(f.scene));
  assert.deepEqual(projectProceduralSources([source], []), { schemaVersion: 1, proceduralRefs: [source.ref] });
  assert.deepEqual(projectProceduralSources([source], readProceduralRefs([source.ref])), { schemaVersion: 1, proceduralSources: [source] });
  verifyProceduralCatalog([source], f.catalog);
  f.catalog.registered_collision!.content_hash = "9".repeat(64);
  assert.throws(() => verifyProceduralCatalog([source], f.catalog));
});

test("recipe proofs reject tamper, unknown work, broken ancestry, duplicate and arbitrary references", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[1] as any).input.sources[0].source += "--changed"; },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[2] as any).output.status = "running"; },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[2] as any).output.cooker.steps[4].error = 1; },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[0] as any).actions.push({ id: "veya/model-generate", sourceHash: "a".repeat(64) }); },
    (f: ReturnType<typeof fixture>) => { f.producer.parent!.runId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.producer.steps.push({ kind: "action", actionId: "veya/world-apply", status: "completed" } as never); },
  ]) { const f = fixture(); change(f); assert.throws(f.read); }
  const [source] = fixture().read(); assert.ok(source);
  assert.throws(() => readProceduralRefs([source.ref, source.ref]));
  assert.throws(() => readProceduralRefs([{ ...source.ref, path: "../outside" }]));
  assert.throws(() => projectProceduralSources([source], [{ ...source.ref, producerRunId: randomUUID() }]));
  assert.throws(() => projectProceduralSources([{ ...source, meshRecipe: { source: "x".repeat(256 * 1024), sha256: source.meshRecipe.sha256 } }], [source.ref]), /capacity/);
});

test("successful submit receipt needs no wait and rejects unknown or competing completion receipts", () => {
  const f = fixture(), queued = f.read();
  (f.producer.steps[1] as any).output = structuredClone(f.producer.steps[2]!.output);
  f.producer.steps.pop();
  assert.deepEqual(f.read(), queued, "an immediate terminal submit proves the same exact recipe and three assets");
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.producer.steps.pop(); },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[1] as any).output.status = "unknown"; },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[1] as any).output = structuredClone(f.producer.steps[2]!.output); },
    (f: ReturnType<typeof fixture>) => { f.producer.steps.push(structuredClone(f.producer.steps[2]!)); },
    (f: ReturnType<typeof fixture>) => { f.producer.steps.push(structuredClone(f.producer.steps[1]!)); },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[2] as any).output.operation_id = "cook_" + "0".repeat(32); },
    (f: ReturnType<typeof fixture>) => { const orphan = structuredClone(f.producer.steps[2]!) as any; orphan.input.operationId = orphan.output.operation_id = "cook_" + "0".repeat(32); f.producer.steps.push(orphan); },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[1] as any).output = structuredClone(f.producer.steps[2]!.output); f.producer.steps.pop(); delete (f.producer.steps[1] as any).output.cooker; },
    (f: ReturnType<typeof fixture>) => { (f.producer.steps[1] as any).output = structuredClone(f.producer.steps[2]!.output); f.producer.steps.pop(); (f.producer.steps[1] as any).output.assets[0].content_hash = "f".repeat(64); },
  ]) { const invalid = fixture(); change(invalid); assert.throws(invalid.read); }
});

test("root source discovery admits 17 through 64 completed producers across batches, rejects 65", () => {
  const f = fixture(), root = f.root;
  root.steps = [];
  const add = (index: number) => {
    const child = fixture(String(index)).producer;
    child.parent = { runId: root.id, stepKey: "main/batch/produce-" + index };
    root.steps.push({ kind: "flow", status: "completed", stepKey: child.parent.stepKey, childRunId: child.id } as never);
    f.runs.set(child.id, child);
  };
  for (let i = 0; i < 17; i++) add(i);
  const seventeen = f.read();
  assert.equal(seventeen.length, 17);
  const refs = readProceduralRefs(seventeen.map(s => s.ref));
  assert.equal((projectProceduralSources(seventeen, refs) as any).proceduralSources.length, 17);
  for (let i = 17; i < 64; i++) add(i);
  const sixtyFour = f.read();
  assert.equal(readProceduralRefs(sixtyFour.map(s => s.ref)).length, 64);
  add(64);
  assert.throws(f.read);
  const extra = fixture("extra").read()[0]!;
  assert.throws(() => readProceduralRefs([...sixtyFour.map(s => s.ref), extra.ref]));
});

test("direct World Agent reads only its current completed subtree without creator identity or worker fallback", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "aura-procedural-direct-"));
  let calls = 0;
  try {
    const capability = new VeyaCreatorCapability(new VeyaCreatorBindings(directory), f.get, { async invoke(_cap, op, _input, _signal, context) {
      assert.equal(op, "veya.assets.list"); assert.equal(context?.runId, f.root.id); calls++; return f.catalog;
    } });
    const signal = new AbortController().signal;
    const refs: any = await capability.invoke(VEYA_CREATOR_CAPABILITY, "context", { proceduralRefs: [] }, signal, { runId: f.root.id });
    const result: any = await capability.invoke(VEYA_CREATOR_CAPABILITY, "context", { proceduralRefs: refs.proceduralRefs }, signal, { runId: f.root.id });
    assert.equal(result.proceduralSources[0].meshRecipe.source, f.mesh);
    assert.equal(result.creationId, undefined); assert.equal(result.homeWorldId, undefined); assert.equal(result.budget, undefined);
    await assert.rejects(capability.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: f.root.id }));
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("creator source queries admit only identity-bound ancestral resource pins and fail closed if binding disappears", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "aura-procedural-bound-")), worker = join(directory, "worker.json");
  f.root.flow.id = "veya/veya-wish"; f.root.status = "completed";
  const current = { id: randomUUID(), requestId: randomUUID(), flow: { id: "veya/veya-wish" }, status: "running", steps: [] } as unknown as FlowRun;
  f.runs.set(current.id, current);
  const [source] = f.read(); assert.ok(source);
  const identity = { creationSessionId: "c".repeat(32), playerId: "player", homeWorldId: "home", sessionPath: worker };
  const previous = { ...identity, runId: f.root.id, input: { operation: "create_world", text: "garden" } };
  const record = { ...identity, runId: current.id, input: { operation: "create_world", text: "garden", reuseAssetsFromRequestId: f.root.requestId },
    assetReuse: { schemaVersion: 1, sourceRequestId: f.root.requestId, sourceRunId: f.root.id,
      items: [{ requirement: { id: "garden", kind: "procedural", description: f.input.description, requiredActions: [] }, binding: source.binding,
        producer: { runId: f.producer.id, operationId: source.ref.operationId, sourceHash: source.ref.sourceHash } }] } };
  const file = join(directory, ".aura/veya-creator/bindings.json");
  const save = () => writeFile(file, JSON.stringify({ version: 1, bindings: { [current.requestId]: record, [f.root.requestId]: previous } }));
  let calls = 0;
  try {
    await mkdir(join(directory, ".aura/veya-creator"), { recursive: true }); await save();
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: identity.creationSessionId }));
    const capability = new VeyaCreatorCapability(new VeyaCreatorBindings(directory), f.get, { async invoke(_cap, op) {
      calls++;
      if (op === "veya.system.context") return { tools: CREATOR_REQUIRED_TOOLS.map(name => ({ name })), system: { creation_verification: Object.fromEntries(CREATOR_REQUIRED_VERIFICATION.map(name => [name, 1])) } };
      assert.equal(op, "veya.assets.list"); return f.catalog;
    } });
    const signal = new AbortController().signal;
    const plain: any = await capability.invoke(VEYA_CREATOR_CAPABILITY, "context", {}, signal, { runId: current.id });
    assert.deepEqual(plain.proceduralRefs, [source.ref]); assert.equal(plain.proceduralSources, undefined);
    const projected: any = await capability.invoke(VEYA_CREATOR_CAPABILITY, "context", { proceduralRefs: [source.ref] }, signal, { runId: current.id });
    assert.equal(projected.proceduralSources[0].meshRecipe.source, f.mesh); assert.equal(projected.assetReuse, undefined);
    previous.playerId = "other"; await save();
    const count = calls;
    await assert.rejects(capability.invoke(VEYA_CREATOR_CAPABILITY, "context", { proceduralRefs: [source.ref] }, signal, { runId: current.id }));
    assert.equal(calls, count, "cross-identity request does not reach any native session");
    await writeFile(file, JSON.stringify({ version: 1, bindings: {} }));
    await assert.rejects(capability.invoke(VEYA_CREATOR_CAPABILITY, "context", { proceduralRefs: [] }, signal, { runId: current.id }));
    assert.equal(calls, count, "missing creator binding never becomes ordinary WorldAgent access");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
