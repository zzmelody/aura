import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { WorkflowRunStore } from "../src/workflow-run-store.ts";

const endpoint = "http://localhost:4311";
function run(id = "run-1", updatedAt = 1): FlowRun {
  return {
    id,
    requestId: id,
    flow: { id: "flow", title: "Flow", description: "", sourceHash: "hash" },
    input: {},
    mode: "demo",
    status: "completed",
    createdAt: 0,
    updatedAt,
    steps: [],
  };
}

test("multiple views share one request and unchanged responses preserve identity", async (t) => {
  const pending = Promise.withResolvers<FlowRun>();
  let calls = 0;
  const store = new WorkflowRunStore(async () => {
    calls++;
    return pending.promise;
  });
  t.after(() => store.close());
  let notifications = 0;
  const first = store.subscribe(endpoint, "run-1", () => notifications++);
  const second = store.subscribe(endpoint, "run-1", () => notifications++);
  const request = store.refresh(endpoint, "run-1");
  pending.resolve(run());
  await request;
  assert.equal(calls, 1);
  assert.equal(notifications, 2);
  const snapshot = store.snapshot(endpoint, "run-1");
  store.publish(endpoint, run());
  assert.equal(store.snapshot(endpoint, "run-1"), snapshot);
  store.publish(endpoint, run("run-1", 0));
  assert.equal(store.snapshot(endpoint, "run-1"), snapshot);
  first();
  second();
});

test("one unmount cannot cancel a request still used by another view", async (t) => {
  let signal: AbortSignal | undefined;
  const store = new WorkflowRunStore(async (_endpoint, _id, abort) => {
    signal = abort;
    return new Promise<FlowRun>((_resolve, reject) => {
      abort.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  });
  t.after(() => store.close());
  const first = store.subscribe(endpoint, "run-1", () => {});
  const second = store.subscribe(endpoint, "run-1", () => {});
  const pending = store.refresh(endpoint, "run-1");
  await Promise.resolve();
  first();
  assert.equal(signal?.aborted, false);
  second();
  assert.equal(signal?.aborted, true);
  await assert.rejects(pending, /aborted/u);
});

test("inactive Run snapshots are bounded while subscribed Runs remain available", (t) => {
  const store = new WorkflowRunStore();
  t.after(() => store.close());
  store.publish(endpoint, run("pinned"));
  const stop = store.subscribe(endpoint, "pinned", () => {});
  for (let i = 0; i < 60; i++) store.publish(endpoint, run(String(i)));
  assert.equal(store.snapshot(endpoint, "0").run, undefined);
  assert.equal(store.snapshot(endpoint, "59").run?.id, "59");
  assert.equal(store.snapshot(endpoint, "pinned").run?.id, "pinned");
  stop();
});
