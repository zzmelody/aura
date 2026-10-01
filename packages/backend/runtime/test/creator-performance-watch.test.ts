import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { FlowRun } from "@aura/protocol/types";
import { activePerformance } from "./creator-acceptance/performance-watch-support.ts";

function fixture() {
  const root = { id: randomUUID(), status: "running", flow: { id: "veya/veya-wish" }, steps: [] } as unknown as FlowRun;
  const baseline = { id: randomUUID(), status: "running", flow: { id: "veya/veya-verify-baseline" },
    parent: { runId: root.id, stepKey: "main/baseline" }, input: { candidate: { contentHash: "a".repeat(64) }, baseline: "authored" },
    steps: [{ kind: "action", actionId: "veya/world-performance", id: "performance", stepKey: "plugin/main/performance", status: "running",
      startedAt: 1234, input: { candidateHash: "a".repeat(64) } }] } as unknown as FlowRun;
  root.steps = [{ kind: "flow", status: "running", stepKey: "main/baseline", childRunId: baseline.id }] as never;
  return { root, baseline, get: async (id: string) => { assert.equal(id, baseline.id); return baseline; } };
}

// Status snapshots alone did not ensure the ten-second sampling window was
// observed before completion. These tests distinguish real running and late reads.
test("performance watcher reports the active action's exact identity before completion", async () => {
  const f = fixture(), events = await activePerformance(f.root, f.get);
  assert.deepEqual(events.map(e => e.kind), ["baseline_entered", "performance_running"]);
  assert.equal(events[1]!.runId, f.baseline.id); assert.equal(events[1]!.rootRunId, f.root.id);
  assert.equal(events[1]!.candidateHash, "a".repeat(64)); assert.equal(events[1]!.startedAt, 1234);
  assert.equal(events[1]!.stepKey, "plugin/main/performance");
  f.baseline.steps = [];
  assert.deepEqual((await activePerformance(f.root, f.get)).map(e => e.kind), ["baseline_entered"]);
});

test("late performance observation is explicitly missed; changed candidate or ancestry is rejected", async () => {
  const f = fixture(); f.baseline.steps[0]!.status = "completed"; f.baseline.steps[0]!.finishedAt = 11234;
  assert.equal((await activePerformance(f.root, f.get))[1]!.kind, "performance_missed");
  (f.baseline.steps[0] as any).input.candidateHash = "b".repeat(64);
  await assert.rejects(activePerformance(f.root, f.get), /differs/);
  f.baseline.steps = []; f.baseline.parent!.runId = randomUUID();
  await assert.rejects(activePerformance(f.root, f.get), /ancestry/);
  const ignored = fixture(); ignored.root.steps[0]!.status = "completed";
  assert.deepEqual(await activePerformance(ignored.root, async () => { throw new Error("completed branches must not be polled"); }), []);
});
