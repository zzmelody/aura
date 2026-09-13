import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "@aura/core";
import type { FlowRun, FlowRunSummary } from "@aura/protocol/types";
import {
  applyWorkflowRun,
  mergeWorkflowRuns,
  workflowRunKey,
} from "../src/workflowSessions.ts";

const endpoint = "http://localhost:4311";
const summary: FlowRunSummary = {
  id: "run-1",
  flowId: "research",
  title: "Research",
  inputPreview: "A task",
  status: "running",
  mode: "demo",
  createdAt: 100,
};

test("server history becomes workflow conversations and polling preserves identity", () => {
  const state = mergeWorkflowRuns(initialState(), [summary], endpoint);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].workflow?.id, "research");
  assert.equal(state.sessions[0].messages[1].status, "streaming");
  assert.equal(mergeWorkflowRuns(state, [summary], endpoint), state);
  const completed = mergeWorkflowRuns(
    state,
    [{ ...summary, status: "completed" }],
    endpoint,
  );
  assert.equal(completed.sessions.length, 1);
  assert.equal(completed.sessions[0].messages[1].status, "complete");
});

test("multiple runs stay in their originating conversation and endpoints do not collide", () => {
  const state = mergeWorkflowRuns(initialState(), [summary], endpoint);
  state.sessions[0].messages.push({
    id: "second",
    role: "assistant",
    text: "running",
    status: "streaming",
    workflowRunId: "run-2",
    workflowPhase: "running",
  });
  const merged = mergeWorkflowRuns(
    state,
    [summary, { ...summary, id: "run-2", status: "completed" }],
    endpoint,
  );
  assert.equal(merged.sessions.length, 1);
  assert.equal(merged.sessions[0].messages[2].workflowPhase, "completed");
  assert.equal(
    mergeWorkflowRuns(merged, [summary], "https://other.example").sessions
      .length,
    2,
  );
});

test("deleted runs remain hidden and pending submissions do not create duplicate sessions", () => {
  const state = {
    ...initialState(),
    hiddenWorkflowRuns: [workflowRunKey(endpoint, summary.id)],
  };
  assert.equal(mergeWorkflowRuns(state, [summary], endpoint), state);
  assert.equal(
    mergeWorkflowRuns(initialState(), [summary], endpoint, false).sessions
      .length,
    0,
  );
});

test("full output updates only its run and survives later summary polls", () => {
  const state = mergeWorkflowRuns(initialState(), [summary], endpoint);
  const run: FlowRun = {
    id: summary.id,
    requestId: "request-1",
    flow: {
      id: "research",
      title: "Research",
      description: "",
      sourceHash: "hash",
    },
    input: {},
    mode: "demo",
    status: "completed",
    createdAt: 100,
    steps: [],
    output: { report: "Completed report" },
  };
  const updated = applyWorkflowRun(state, endpoint, run);
  assert.equal(updated.sessions[0].messages[0].text, "{}");
  assert.equal(updated.sessions[0].messages[1].text, "Completed report");
  assert.equal(applyWorkflowRun(updated, endpoint, run), updated);
  assert.equal(
    mergeWorkflowRuns(updated, [{ ...summary, status: "completed" }], endpoint),
    updated,
  );
  assert.equal(
    applyWorkflowRun(updated, "https://other.example", run),
    updated,
  );
});
