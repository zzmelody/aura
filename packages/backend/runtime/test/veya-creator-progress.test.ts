import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun, FlowStep } from "@aura/protocol/types";
import { creatorProgress } from "../src/veya-creator-progress.ts";

const run = (id: string, flow: string, steps: unknown[], parent?: string): FlowRun => ({
  id, requestId: "creation", flow: { id: flow }, createdAt: 1000, status: "running", steps,
  ...(parent ? { parent: { runId: parent } } : {}), input: {},
} as FlowRun);
const child = (id: string, flowId: string) => ({ id: "child", kind: "flow", status: "running", childRunId: id, flowId });
const key = "a".repeat(64);

test("nested paid image progress is creation/work scoped and exposes no diagnostics or task IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creator-progress-"));
  try {
    await mkdir(join(directory, ".aura"));
    await writeFile(join(directory, ".aura/world-agent-paid.json"), JSON.stringify({ schemaVersion: 1, requests: {
      [`creation:${key}`]: { creationId: "creation", stages: { front: { status: "completed", taskId: "secret-provider-id" }, left: { status: "submitted" } } },
      [`other:${key}`]: { creationId: "other", stages: { front: { status: "completed" }, left: { status: "completed" } } },
    } }));
    const root = run("root", "veya/veya-wish", [child("prop", "veya/veya-prop-agent")]);
    const prop = run("prop", "veya/veya-prop-agent", [child("model", "veya/veya-model-generator")], "root");
    const model = run("model", "veya/veya-model-generator", [{ id: "generate-model", kind: "action", status: "running", startedAt: 3000, input: { generationKey: key } }], "prop");
    const progress = await creatorProgress(root, async id => id === "prop" ? prop : model, directory, "creation", 9000);
    assert.equal(progress.stage, "reference_images"); assert.equal(progress.imagesReady, 1); assert.equal(progress.imagesTotal, 4);
    assert.equal(progress.elapsedSeconds, 6); assert.equal(progress.totalSeconds, 8);
    assert.ok(!JSON.stringify(progress).includes("secret-provider-id"));
    assert.ok(!JSON.stringify(progress).includes(directory));
    const ledger = { schemaVersion: 1, requests: { [`creation:${key}`]: { creationId: "creation", stages: { model: { status: "submitted" } } } } };
    await writeFile(join(directory, ".aura/world-agent-paid.json"), JSON.stringify(ledger));
    assert.equal((await creatorProgress(root, async id => id === "prop" ? prop : model, directory)).stage, "model");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("completed stages require ready receipts; repairs do not imply passed verification", async () => {
  const root = run("root", "veya/veya-prop-agent", [
    { id: "assets", kind: "flow", flowId: "veya/veya-world-assets", status: "completed", output: { status: "ready" } },
    { id: "prepare", kind: "flow", flowId: "veya/veya-prop-prepare", status: "completed", output: { status: "ready" } },
    { id: "verify", kind: "flow", flowId: "veya/veya-world-verify", status: "completed", output: { playtest: "failed" } },
    { id: "author", kind: "agent", status: "running", startedAt: 5000, error: "private/path" },
  ]);
  root.input = { repairRound: 1 };
  const p = await creatorProgress(root, async () => { throw Error("unused"); }, "unused", undefined, 12000);
  assert.equal(p.stage, "authoring"); assert.deepEqual(p.completedStages, ["assets", "preparation"]); assert.equal(p.repairRound, 1);
  assert.ok(!JSON.stringify(p).includes("private/path"));
});

test("missing children degrade safely and unrelated children never enter the projection", async () => {
  const root = run("root", "veya/veya-wish", [child("child", "veya/veya-prop-agent")]);
  const unrelated = run("child", "veya/veya-model-generator", [], "another-root");
  assert.equal((await creatorProgress(root, async () => unrelated, "unused")).stage, "requirements");
  assert.equal((await creatorProgress(root, async () => { throw Error("secret raw failure"); }, "unused")).stage, "requirements");
});

test("terminal states never follow stale active children or imply success", async () => {
  const root = run("root", "veya/veya-wish", [child("child", "veya/veya-prop-agent")]); root.status = "interrupted";
  let reads = 0;
  const p = await creatorProgress(root, async () => { reads++; throw Error(); }, "unused");
  assert.equal(p.stage, "attention"); assert.equal(reads, 0); assert.deepEqual(p.completedStages, []);
});

test("verification distinguishes live work, and clarification remains answerable", async () => {
  const root = run("root", "veya/veya-verify-baseline", [{ id: "global-vision", kind: "agent", status: "running" }]);
  assert.equal((await creatorProgress(root, async () => { throw Error(); }, "unused")).detail, "visual");
  root.status = "waiting_input"; root.steps = [{ id: "clarify", kind: "checkpoint", status: "waiting_input" } as FlowStep];
  assert.equal((await creatorProgress(root, async () => { throw Error(); }, "unused")).stage, "clarification");
});
