import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readCreatorBindingDocument } from "@aura/orchestration";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { retainedWorldDesign } from "../src/veya-creator-world-design-recovery.ts";
import { verifyDesignFormatProof } from "../src/veya-creator-format-proof.ts";
import { createVeyaCreatorApp, VeyaCreatorService } from "../src/veya-creator-routes.ts";

// Existing paid-prop recovery intentionally cannot admit this pre-production
// world path. A malformed design must not reopen hidden writes or re-plan.
function fixture() {
  const make = (flow: string, input: unknown, output: unknown) => ({ id: randomUUID(), requestId: randomUUID(),
    flow: { id: flow }, input, output, status: "completed", steps: [] }) as unknown as FlowRun;
  const brief = { schemaVersion: 1, operation: "create_world", summary: "read courtyard", constraints: ["reuse exact asset"], acceptance: ["read and return"] };
  const plan = { operation: "copy", targetWorldId: "creation-template", gaps: [], assets: [{ id: "raw", assetId: "raw_model", version: "a".repeat(64) }], requirements: brief };
  const root = make("veya/veya-wish", { operation: "create_world", text: "original request" }, { status: "blocked" });
  const world = make("veya/veya-world-agent", { task: "read courtyard", outputMode: "artifact", brief }, { status: "needs_attention" });
  const planner = make("veya/veya-world-plan", { brief }, plan);
  const designInput = { scope: "world", modular: true, task: "read courtyard", plan: { ...plan,
    returnHome: { schemaVersion: 1, binding: "personal_home", entityId: "return_home", arrival: "home_return" } } };
  const design = make("veya/veya-world-gameplay-design", designInput, { status: "blocked", issues: [{ code: "invalid_spec", detail: "SyntaxError" }] });
  const action = (run: FlowRun, id: string, actionId: string, output: unknown = {}) => run.steps.push({ id, kind: "action", actionId,
    status: "completed", stepKey: `main/${id}`, output } as never);
  const agent = (run: FlowRun, id: string, output: unknown, actions: string[]) => run.steps.push({ id, kind: "agent", status: "completed",
    stepKey: `main/${id}`, output, actions: actions.map(id => ({ id, sourceHash: "f".repeat(64) })) } as never);
  const link = (parent: FlowRun, child: FlowRun, id: string) => {
    child.parent = { runId: parent.id, stepKey: `main/${id}` };
    parent.steps.push({ id, kind: "flow", status: "completed", childRunId: child.id, stepKey: `main/${id}` } as never);
  };
  const context = { creationId: root.requestId, operation: "create_world" };
  action(root, "context", "veya/creator-context", context); agent(root, "understand-0", "{}", []); link(root, world, "world");
  action(world, "creator-context", "veya/creator-context", context); link(world, planner, "plan"); link(world, design, "gameplay-design");
  agent(planner, "plan", "{}", ["veya/world-read", "veya/asset-list"]);
  action(design, "capabilities", "veya/system-context"); agent(design, "draft", '{"x":[1}]}', ["veya/system-context", "veya/world-read"]);
  const runs = new Map([root, world, planner, design].map(run => [run.id, run]));
  return { root, world, planner, design, plan, brief, designInput, runs, action, agent, link, make,
    get: async (id: string) => { const run = runs.get(id); assert.ok(run); return run; } };
}
async function unchangedCorrectionFixture() {
  const original = fixture(), prior = await retainedWorldDesign(original.root, original.root.requestId, original.get);
  const root = original.make("veya/veya-wish", { ...original.root.input as object, previousRequestId: original.root.requestId }, { status: "blocked" });
  const world = original.make("veya/veya-world-agent", { ...original.world.input as object, designRecovery: structuredClone(prior) }, { status: "needs_attention" });
  const design = original.make("veya/veya-world-gameplay-design", { ...original.designInput,
    formatDraft: { text: prior.draftText, hash: prior.draftHash } }, { status: "blocked", issues: [{ code: "invalid_revision" }] });
  const context = { creationId: root.requestId, operation: "create_world", worldDesignRecovery: structuredClone(prior) };
  original.action(root, "context", "veya/creator-context", structuredClone(context)); original.link(root, world, "world");
  original.action(world, "creator-context", "veya/creator-context", structuredClone(context)); original.link(world, design, "gameplay-design");
  original.action(design, "capabilities", "veya/system-context"); original.agent(design, "format-correct", prior.draftText, []);
  for (const run of [root, world, design]) original.runs.set(run.id, run);
  return { ...original, original, root, world, design, prior };
}
async function retainedReviewFixture() {
  const previous = await unchangedCorrectionFixture(), prior = await retainedWorldDesign(previous.root, previous.root.requestId, previous.get, previous.prior);
  const root = previous.make("veya/veya-wish", { ...previous.root.input as object, previousRequestId: previous.root.requestId }, { status: "blocked" });
  const world = previous.make("veya/veya-world-agent", { ...previous.world.input as object, designRecovery: structuredClone(prior) }, { status: "needs_attention" });
  const critical = ["preserve performance category", "keep the original requirement"];
  const design = previous.make("veya/veya-world-gameplay-design", structuredClone(previous.design.input),
    { status: "blocked", issues: critical.map(detail => ({ code: "playability_review", detail })) });
  const context = { creationId: root.requestId, operation: "create_world", worldDesignRecovery: structuredClone(prior) };
  previous.action(root, "context", "veya/creator-context", structuredClone(context)); previous.link(root, world, "world");
  previous.action(world, "creator-context", "veya/creator-context", structuredClone(context)); previous.link(world, design, "gameplay-design");
  previous.action(design, "capabilities", "veya/system-context");
  previous.agent(design, "revise", '{"schemaVersion":2,"acceptance":[{"id":"performance","kind":"playtest"}]}', []);
  previous.agent(design, "review-revision", JSON.stringify({ criticalIssues: critical, notes: ["not a pass"] }), []);
  for (const run of [root, world, design]) previous.runs.set(run.id, run);
  return { ...previous, previous, root, world, design, prior };
}
async function normalizedReviewFixture() {
  const actual = JSON.parse(await readFile(new URL("./fixtures/creator-design-two-closures.json", import.meta.url), "utf8"));
  const original = fixture(); (original.design.steps[1] as any).output = actual.raw;
  const prior = await retainedWorldDesign(original.root, original.root.requestId, original.get);
  const root = original.make("veya/veya-wish", { ...original.root.input as object, previousRequestId: original.root.requestId }, { status: "blocked" });
  const world = original.make("veya/veya-world-agent", { ...original.world.input as object, designRecovery: structuredClone(prior) }, { status: "needs_attention" });
  const design = original.make("veya/veya-world-gameplay-design", { ...original.designInput,
    formatDraft: { text: prior.draftText, hash: prior.draftHash } }, structuredClone(actual.output));
  const context = { creationId: root.requestId, operation: "create_world", worldDesignRecovery: structuredClone(prior) };
  original.action(root, "context", "veya/creator-context", structuredClone(context)); original.link(root, world, "world");
  original.action(world, "creator-context", "veya/creator-context", structuredClone(context)); original.link(world, design, "gameplay-design");
  original.action(design, "capabilities", "veya/system-context");
  original.agent(design, "revise", actual.revised, []);
  original.agent(design, "review-revision", JSON.stringify({ criticalIssues: actual.output.issues.map((i: any) => i.detail), notes: [] }), []);
  for (const run of [root, world, design]) original.runs.set(run.id, run);
  return { ...original, original, root, world, design, prior, actual };
}

test("actual deterministic two-closure record admits one exact retained review without a new semantic budget", async () => {
  const f = await normalizedReviewFixture(); addCatalog(f.design); addIdentities(f.design);
  const grant = await retainedWorldDesign(f.root, f.root.requestId, f.get, f.prior);
  assert.equal(grant.specHash, "c7a5842a7423390ad7a0b105afbb10816f6d065305acedcffedf08c71fe417b3");
  assert.deepEqual(grant.retainedSpec, JSON.parse(f.actual.revised));
  assert.equal(grant.formatCorrectionUsed, true); assert.equal(grant.semanticRevisionUsed, true); assert.equal(grant.reviewRetryUsed, true);
  assert.deepEqual(grant.plan, f.prior.plan); assert.equal(grant.draftText, f.actual.raw);
  await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get, grant), /previous_request_unavailable/u);
});

test("recorded punctuation proof rejects changed bytes, offsets, strings, methods, hashes and unconsumed valid JSON", async () => {
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const raw = '{"x":[1}]}', text = '{"x":[1]}', revised = { x: [2] };
  const proof = { beforeHash: hash(raw), afterHash: hash(JSON.stringify(revised)), formatSourceHash: hash(raw),
    formatResultHash: hash(text), formatCorrected: true, formatMethod: "unique_closing_bracket", formatOffset: 7,
    formatOffsets: [7], issues: [{ code: "invalid_spec" }] };
  verifyDesignFormatProof(raw, hash(raw), revised, proof);
  for (const patch of [{ formatOffsets: [7, 7] }, { formatOffset: 6 }, { formatMethod: "model_guess" },
    { beforeHash: "f".repeat(64) }, { afterHash: "f".repeat(64) }, { formatSourceHash: "f".repeat(64) },
    { formatResultHash: hash('{"x":[3]}') }, { formatCorrected: false }, { issues: [] }])
    assert.throws(() => verifyDesignFormatProof(raw, hash(raw), revised, { ...proof, ...patch }), /previous_request_unavailable/u);
  const quoted = '{"x":"}"}';
  assert.throws(() => verifyDesignFormatProof(quoted, hash(quoted), revised,
    { ...proof, beforeHash: hash(quoted), formatSourceHash: hash(quoted), formatOffset: 6, formatOffsets: [6] }), /previous_request_unavailable/u);
});

test("deterministic retained review rejects altered ancestry, missing criticism, hidden work and forged normalization", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => { (f.design.output as any).designRevision.formatOffsets = [5197]; },
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => { (f.design.output as any).designRevision.formatOffsets = [5198, 5456]; },
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => { (f.design.output as any).designRevision.afterHash = "a".repeat(64); },
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => { (f.design.output as any).designRevision.formatResultHash = "a".repeat(64); },
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => { (f.original.design.steps[1] as any).output += " "; },
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => { (f.design.output as any).issues = []; },
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => { (f.design.steps[1] as any).actions = [{ id: "veya/world-read", sourceHash: "f".repeat(64) }]; },
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => f.action(f.world, "copy", "veya/world-copy"),
    (f: Awaited<ReturnType<typeof normalizedReviewFixture>>) => f.agent(f.design, "draft", "{}", []),
  ]) { const f = await normalizedReviewFixture(); mutate(f);
    await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get, f.prior), /previous_request_unavailable/u); }
});
function addCatalog(design: FlowRun) {
  design.steps.splice(1, 0, { id: "asset-catalog", kind: "action", actionId: "veya/asset-list", input: {},
    status: "completed", stepKey: "main/asset-catalog", output: { nav: { id: "nav", type: "navigation", content_hash: "a".repeat(64) } } } as never);
}
function addIdentities(design: FlowRun) {
  design.steps.splice(1, 0, { id: "source-entities", kind: "action", actionId: "veya/world-read",
    input: { worldId: "creation-template", includeAuthoredEntities: true }, status: "completed", stepKey: "main/source-entities",
    output: { manifest: { world_id: "creation-template" }, revision: 1, content_hash: "a".repeat(64),
      authored_entities: [{ id: "player" }, { id: "return_home" }] } } as never);
}

test("syntax recovery admits only the exact optional native authored-identity read", async () => {
  const f = fixture(), old = await retainedWorldDesign(f.root, f.root.requestId, f.get);
  addCatalog(f.design); addIdentities(f.design);
  assert.deepEqual(await retainedWorldDesign(f.root, f.root.requestId, f.get), old);
  for (const mutate of [
    (g: ReturnType<typeof fixture>) => addIdentities(g.design),
    (g: ReturnType<typeof fixture>) => { (g.design.steps[1] as any).input.worldId = "other"; },
    (g: ReturnType<typeof fixture>) => { (g.design.steps[1] as any).input.includeAuthoredEntities = false; },
    (g: ReturnType<typeof fixture>) => { (g.design.steps[1] as any).input.requestId = randomUUID(); },
    (g: ReturnType<typeof fixture>) => { (g.design.steps[1] as any).actionId = "veya/world-copy"; },
    (g: ReturnType<typeof fixture>) => { delete (g.design.steps[1] as any).output.authored_entities; },
    (g: ReturnType<typeof fixture>) => { (g.design.steps[1] as any).output.authored_entities.push({ id: "player" }); },
    (g: ReturnType<typeof fixture>) => { (g.design.steps[1] as any).output.authored_entities = [{ id: 7 }]; },
    (g: ReturnType<typeof fixture>) => { (g.design.steps[1] as any).output.content_hash = "not-a-hash"; },
  ]) {
    const g = fixture(); addIdentities(g.design); mutate(g);
    await assert.rejects(retainedWorldDesign(g.root, g.root.requestId, g.get), /previous_request_unavailable/u);
  }
});

test("authored identity recovery matches the native 512-entry and 192-character limits", async () => {
  const f = fixture(); addIdentities(f.design);
  const output = (f.design.steps[1] as any).output;
  output.authored_entities = Array.from({ length: 512 }, (_, i) => ({ id: i === 0 ? "x".repeat(192) : `entity_${i}` }));
  assert.equal((await retainedWorldDesign(f.root, f.root.requestId, f.get)).sourceRunId, f.root.id);
  output.authored_entities.push({ id: "extra" });
  await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get), /previous_request_unavailable/u);
  output.authored_entities.pop(); output.authored_entities[0].id += "x";
  await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get), /previous_request_unavailable/u);
});
test("world syntax recovery retains exact durable plan/brief/raw bytes and has one unused correction", async () => {
  const f = fixture(), result = await retainedWorldDesign(f.root, f.root.requestId, f.get);
  assert.deepEqual(result, { schemaVersion: 1, sourceRequestId: f.root.requestId, sourceRunId: f.root.id,
    brief: f.brief, plan: f.plan, designInput: f.designInput, draftText: '{"x":[1}]}',
    draftHash: createHash("sha256").update('{"x":[1}]}', "utf8").digest("hex"), formatCorrectionUsed: false });
});
test("world design recovery admits only the optional exact read-only asset catalog across old and new stage shapes", async () => {
  const f = fixture(), old = await retainedWorldDesign(f.root, f.root.requestId, f.get);
  addCatalog(f.design);
  assert.deepEqual(await retainedWorldDesign(f.root, f.root.requestId, f.get), old);
  const correction = await unchangedCorrectionFixture();
  addCatalog(correction.original.design); addCatalog(correction.design);
  const corrected = await retainedWorldDesign(correction.root, correction.root.requestId, correction.get, correction.prior);
  assert.equal(corrected.formatCorrectionUsed, true);
  const review = await retainedReviewFixture();
  addCatalog(review.previous.original.design); addCatalog(review.previous.design); addCatalog(review.design);
  const retained = await retainedWorldDesign(review.root, review.root.requestId, review.get, review.prior);
  assert.equal(retained.semanticRevisionUsed, true); assert.equal(retained.reviewRetryUsed, true);
  await assert.rejects(retainedWorldDesign(review.root, review.root.requestId, review.get, retained), /previous_request_unavailable/u);
});
test("asset catalog admission cannot disguise extra actions, writes, payloads or spent semantic revisions", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); addCatalog(f.design); },
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); (f.design.steps[1] as any).actionId = "veya/cooker-submit"; },
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); (f.design.steps[1] as any).actionId = "veya/model-generate"; },
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); (f.design.steps[1] as any).actionId = "veya/world-list"; },
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); (f.design.steps[1] as any).input = { source: "untrusted" }; },
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); f.action(f.design, "another-catalog", "veya/asset-list"); },
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); f.agent(f.design, "revise", "{}", []);
      f.design.output = { status: "blocked", issues: [{ code: "design_identity_changed", detail: "local entity: plaque" }] }; },
    (f: ReturnType<typeof fixture>) => { addCatalog(f.design); f.agent(f.design, "revise", "{}", []); },
  ]) { const f = fixture(); mutate(f); await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get), /previous_request_unavailable/u); }
});
test("world syntax recovery rejects writes, elevated agent tools, hidden children and incomplete steps", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.action(f.planner, "hidden-copy", "veya/world-copy"),
    (f: ReturnType<typeof fixture>) => { (f.design.steps[1] as any).actions.push({ id: "veya/tripo-generate", sourceHash: "f".repeat(64) }); },
    (f: ReturnType<typeof fixture>) => { const hidden = f.make("veya/veya-world-assets", {}, {}); f.runs.set(hidden.id, hidden); f.link(f.planner, hidden, "hidden"); },
    (f: ReturnType<typeof fixture>) => { f.design.steps[1]!.status = "running"; },
    (f: ReturnType<typeof fixture>) => { f.design.parent!.stepKey = "unrelated"; },
    (f: ReturnType<typeof fixture>) => { (f.world.input as any).prior = { artifactId: "a".repeat(64) }; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get), /previous_request_unavailable/u); }
});
test("world syntax recovery rejects changed locked context, valid rejected JSON, reused repair and oversized data", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { (f.planner.input as any).brief = { ...f.brief, summary: "changed" }; },
    (f: ReturnType<typeof fixture>) => { (f.design.input as any).plan = { ...f.designInput.plan, returnHome: { binding: "another_world" } }; },
    (f: ReturnType<typeof fixture>) => { (f.root.input as any).previousRequestId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { (f.design.steps[1] as any).output = '{"valid":true}'; },
    (f: ReturnType<typeof fixture>) => { (f.design.steps[1] as any).output = "x".repeat(128 * 1024 + 1); },
    (f: ReturnType<typeof fixture>) => { (f.root.steps[0] as any).output = { creationId: f.root.requestId, operation: "create_world", worldDesignRecovery: {} }; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get), /previous_request_unavailable/u); }
});
test("unchanged failed model correction retains original proof and records the used correction budget", async () => {
  const f = await unchangedCorrectionFixture();
  const grant = await retainedWorldDesign(f.root, f.root.requestId, f.get, f.prior);
  assert.deepEqual(grant, { ...f.prior, sourceRequestId: f.root.requestId, sourceRunId: f.root.id, formatCorrectionUsed: true });
  await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get), /previous_request_unavailable/u);
});
test("unchanged correction recovery rejects altered bytes, prior proof, repeated budget, hidden descendants and semantic work", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.design.steps[1] as any).output += " "; },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.design.steps[1] as any).output = '{"x":[2}]}'; },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.root.steps[0] as any).output.worldDesignRecovery.draftHash = "a".repeat(64); },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { f.prior.formatCorrectionUsed = true; },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.original.design.steps[1] as any).output += " "; },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.world.input as any).designRecovery.plan.targetWorldId = "another"; },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.design.input as any).formatDraft.hash = "f".repeat(64); },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.root.input as any).text = "another request"; },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => f.agent(f.design, "revise", "{}", []),
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => f.agent(f.design, "review-revision", "{}", []),
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => f.action(f.world, "copy", "veya/world-copy"),
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { const hidden = f.make("veya/veya-world-assets", {}, {});
      f.runs.set(hidden.id, hidden); f.link(f.design, hidden, "hidden"); },
    (f: Awaited<ReturnType<typeof unchangedCorrectionFixture>>) => { (f.design.steps[1] as any).actions = [{ id: "veya/world-read", sourceHash: "f".repeat(64) }]; },
  ]) { const f = await unchangedCorrectionFixture(); mutate(f);
    await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get, f.prior), /previous_request_unavailable/u); }
});
test("retained review uses exact persisted revised JSON and preserves both consumed budgets", async () => {
  const f = await retainedReviewFixture(), result = await retainedWorldDesign(f.root, f.root.requestId, f.get, f.prior);
  const spec = JSON.parse(String(f.design.steps[1]!.output));
  assert.deepEqual(result.retainedSpec, spec);
  assert.equal(result.specHash, createHash("sha256").update(JSON.stringify(spec), "utf8").digest("hex"));
  assert.equal(result.formatCorrectionUsed, true); assert.equal(result.semanticRevisionUsed, true); assert.equal(result.reviewRetryUsed, true);
  assert.equal(result.draftHash, f.prior.draftHash); assert.deepEqual(result.plan, f.prior.plan);
  await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get, result), /previous_request_unavailable/u);
});
test("retained review rejects omitted criticism, invalid revised JSON, changed ancestors and any new production", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => { (f.design.output as any).issues.pop(); },
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => { (f.design.output as any).issues[1].code = "invalid_spec"; },
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => { (f.design.steps[1] as any).output = "{broken"; },
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => { f.design.steps[2]!.status = "running"; },
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => { (f.previous.design.steps[1] as any).output += " "; },
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => { (f.design.input as any).plan.targetWorldId = "another"; },
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => f.action(f.world, "copy", "veya/world-copy"),
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => f.agent(f.design, "draft", "{}", []),
    (f: Awaited<ReturnType<typeof retainedReviewFixture>>) => { f.prior.reviewRetryUsed = true; },
  ]) { const f = await retainedReviewFixture(); mutate(f);
    await assert.rejects(retainedWorldDesign(f.root, f.root.requestId, f.get, f.prior), /previous_request_unavailable/u); }
});
test("world request recovery is owned, fingerprinted, host-persisted and never accepts client recovery JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aura-world-design-recovery-")), linked = await unchangedCorrectionFixture(), f = linked.original, worker = join(directory, "worker.json");
  try {
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "a".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49000/", token: "b".repeat(64) }));
    let starts = 0;
    const flow = { async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", available: true, service: true }] } as T;
      if (method === "get") return await f.get(params.id as string) as T;
      starts++;
      return { id: params.requestId === f.root.requestId ? f.root.id : linked.root.id, status: "completed" } as T;
    } };
    const service = new VeyaCreatorService(directory, flow as never); await service.initialize();
    const token = await service.register("owner", "home", worker), app = createVeyaCreatorApp(service);
    const post = (body: object, bearer = token) => app.request("/tasks", { method: "POST", headers: {
      authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const original = { requestId: f.root.requestId, operation: "create_world", text: "original request" };
    assert.equal((await post(original)).status, 202);
    const retry = { ...original, requestId: linked.root.requestId, previousRequestId: f.root.requestId };
    assert.equal((await post({ ...retry, worldDesignRecovery: {} })).status, 400);
    assert.equal((await post({ ...retry, text: "another request" })).status, 409);
    assert.equal((await post({ ...retry, operation: "create_prop" })).status, 409);
    const otherWorker = join(directory, "other-worker.json");
    await writeFile(otherWorker, JSON.stringify({ role: "creator-worker", creation_session_id: "c".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49001/", token: "d".repeat(64) }));
    const other = await service.register("other", "other-home", otherWorker);
    assert.equal((await post(retry, other)).status, 409);
    const before = await readFile(join(service.directory, "bindings.json")), beforeStarts = starts;
    await writeFile(join(service.directory, "grants"), "injected_grant_directory_failure");
    assert.equal((await post(retry)).status, 503);
    assert.deepEqual(await readFile(join(service.directory, "bindings.json")), before);
    assert.equal(starts, beforeStarts, "a failed immutable write cannot start the request");
    assert.equal((service as any).state.bindings[retry.requestId], undefined, "failed persistence cannot mutate in-memory bindings");
    await rm(join(service.directory, "grants"));
    assert.equal((await post(retry)).status, 202);
    assert.equal(starts, beforeStarts + 1, "the unchanged request starts exactly once after storage recovers");
    const storedBytes = await readFile(join(service.directory, "bindings.json"));
    const disk = JSON.parse(storedBytes.toString("utf8"));
    assert.equal(disk.bindings[retry.requestId].worldDesignRecovery, undefined);
    assert.match(disk.bindings[retry.requestId].worldDesignRecoveryRef.contentHash, /^[a-f0-9]{64}$/u);
    const stored = await readCreatorBindingDocument(directory, storedBytes);
    assert.deepEqual(stored.bindings[retry.requestId].worldDesignRecovery, await retainedWorldDesign(f.root, f.root.requestId, f.get));
    assert.equal(stored.bindings[retry.requestId].recovery, undefined);
    assert.equal(stored.bindings[retry.requestId].recoveryBudgetCreationId, f.root.requestId);
    await service.initialize();
    assert.deepEqual((service as any).state.bindings[retry.requestId].worldDesignRecovery, stored.bindings[retry.requestId].worldDesignRecovery);
    const grantPath = join(service.directory, "grants", disk.bindings[retry.requestId].worldDesignRecoveryRef.grantId + ".json"), grantBytes = await readFile(grantPath);
    await rm(grantPath);
    await assert.rejects(new VeyaCreatorService(directory, flow as never).initialize(), /creator_design_grant_invalid/u,
      "a missing grant is corrupt storage, not an empty newly initialized project");
    await writeFile(grantPath, grantBytes);
    const continuation = { ...retry, requestId: randomUUID(), previousRequestId: retry.requestId };
    assert.equal((await post(continuation)).status, 202);
    const continued = await readCreatorBindingDocument(directory, await readFile(join(service.directory, "bindings.json")));
    assert.equal(continued.bindings[continuation.requestId].worldDesignRecovery.formatCorrectionUsed, true);
    assert.equal(continued.bindings[continuation.requestId].recoveryBudgetCreationId, f.root.requestId);
    assert.equal((await post({ ...continuation, requestId: randomUUID(), previousRequestId: continuation.requestId })).status, 409,
      "the already used model correction cannot be reset or continued again");
  } finally {
    assert.equal(resolve(directory).startsWith(resolve(tmpdir())), true);
    await rm(directory, { recursive: true, force: true });
  }
});
