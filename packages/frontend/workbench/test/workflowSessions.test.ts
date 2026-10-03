import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "@aura/core";
import type { FlowRun, FlowRunSummary } from "@aura/protocol/types";
import {
  applyWorkflowRun,
  chatHistory,
  mergeWorkflowRuns,
  workflowRunKey,
  isWorkflowActive,
  isWorkflowOpen,
  workflowPhaseLabels,
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

test("human waits remain resumable without presenting a running spinner", () => {
  for (const status of [
    "paused",
    "waiting_input",
    "needs_attention",
  ] as const) {
    assert.equal(isWorkflowOpen(status), true);
    assert.equal(isWorkflowActive(status), false);
    const state = mergeWorkflowRuns(
      initialState(),
      [{ ...summary, status }],
      endpoint,
    );
    assert.equal(
      state.sessions[0].messages[1].text,
      workflowPhaseLabels[status],
    );
    assert.equal(state.sessions[0].messages[1].status, "complete");
  }
  assert.equal(isWorkflowActive("pausing"), true);
  assert.equal(isWorkflowOpen("failed"), false);
});

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

test("archived running conversations still receive status updates without reimport or lost metadata", () => {
  const state = mergeWorkflowRuns(initialState(), [summary], endpoint);
  state.sessions[0].archivedAt = 200;
  state.sessions[0].title = "Renamed task";
  const completed = mergeWorkflowRuns(state, [{ ...summary, status: "completed" }], endpoint);
  assert.equal(completed.sessions.length, 1);
  assert.equal(completed.sessions[0].archivedAt, 200);
  assert.equal(completed.sessions[0].title, "Renamed task");
  assert.equal(completed.sessions[0].messages[1].workflowPhase, "completed");
  assert.equal(completed.hiddenWorkflowRuns, undefined);
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

test("runs started from an ordinary chat stay inside that chat", () => {
  const ref = { id: "research", title: "Research", endpoint };
  const state = {
    ...initialState(),
    sessions: [
      {
        id: "chat",
        title: "plain",
        updatedAt: 1,
        messages: [
          { id: "q", role: "user" as const, text: "hi", status: "complete" as const },
          {
            id: "run-1:output",
            role: "assistant" as const,
            text: "正在运行",
            status: "streaming" as const,
            workflowRunId: "run-1",
            workflowPhase: "queued" as const,
            workflow: ref,
          },
        ],
      },
    ],
  };
  const merged = mergeWorkflowRuns(state, [summary], endpoint);
  assert.equal(merged.sessions.length, 1);
  assert.equal(merged.sessions[0].workflow, undefined);
  assert.equal(merged.sessions[0].messages[1].workflowPhase, "running");
  const other = mergeWorkflowRuns(state, [summary], "http://127.0.0.1:9999");
  assert.equal(other.sessions.length, 2);
  const run = {
    id: "run-1",
    flowId: "research",
    title: "Research",
    status: "completed",
    mode: "demo",
    createdAt: 100,
    input: { task: "A task" },
    output: { report: "done" },
    steps: [],
  } as unknown as FlowRun;
  const applied = applyWorkflowRun(merged, endpoint, run);
  assert.equal(applied.sessions[0].messages[1].text, "done");
  assert.equal(applied.sessions[0].messages[1].status, "complete");
  assert.equal(applied.sessions[0].messages[0].text, "hi");
});

test("chat context summarizes settled runs and drops run inputs", () => {
  const ref = { id: "research", title: "Research", endpoint };
  const history = chatHistory([
    { id: "q", role: "user", text: "hi", status: "complete" },
    { id: "run-1:input", role: "user", text: "{\"task\":\"x\"}", status: "complete" },
    {
      id: "run-1:output",
      role: "assistant",
      text: "report body",
      status: "complete",
      workflowRunId: "run-1",
      workflowPhase: "completed",
      workflow: ref,
    },
    { id: "run-2:input", role: "user", text: "y", status: "complete" },
    {
      id: "run-2:output",
      role: "assistant",
      text: "正在运行",
      status: "streaming",
      workflowRunId: "run-2",
      workflowPhase: "running",
      workflow: ref,
    },
    { id: "f", role: "user", text: "结果怎么样？", status: "complete" },
  ]);
  assert.deepEqual(
    history.map((m) => [m.role, m.text]),
    [
      ["user", "hi"],
      ["assistant", "[Research · 已完成]\nreport body"],
      ["user", "结果怎么样？"],
    ],
  );
});
