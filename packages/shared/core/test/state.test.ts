import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, restoreState, validateEndpoint } from "@aura/core";

test("restoration rejects incompatible data and sanitizes message status", () => {
  assert.deepEqual(restoreState(null), initialState());
  assert.deepEqual(restoreState({ version: 9, sessions: [] }), initialState());
  const restored = restoreState({
    version: 1,
    theme: "light",
    sessions: [
      null,
      {
        id: "s",
        title: "idea",
        updatedAt: 1,
        messages: [
          { id: "a", role: "assistant", text: "partial", status: "streaming" },
          { role: "system", text: "bad" },
        ],
      },
    ],
  });
  assert.equal(restored.theme, "light");
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].messages.length, 1);
  assert.equal(restored.sessions[0].messages[0].status, "stopped");
});

test("service URL admits only HTTP origins without credentials", () => {
  assert.equal(
    validateEndpoint(" http://192.168.1.2:4311/ "),
    "http://192.168.1.2:4311",
  );
  assert.equal(validateEndpoint("https://example.com"), "https://example.com");
  for (const input of [
    "javascript:alert(1)",
    "ftp://localhost",
    "http://user:secret@localhost",
    "http://localhost/api",
    "http://localhost?key=x",
    "bad",
  ])
    assert.equal(validateEndpoint(input), null);
});

test("restoration preserves the DSH Codex provider selection", () => {
  const restored = restoreState({
    version: 1,
    provider: "codex",
    sessions: [],
  });
  assert.equal(restored.provider, "codex");
});

test("workflow conversations restore bindings, run references and pending request identity", () => {
  const workflow = {
    id: "research",
    title: "Research",
    endpoint: "http://localhost:4311",
    inputSchema: { type: "object" },
    pending: {
      requestId: "request-1",
      mode: "demo",
      input: { task: "Research" },
    },
  };
  const restored = restoreState({
    version: 1,
    hiddenWorkflowRuns: ["http://localhost:4311/removed", null],
    sessions: [
      {
        id: "s",
        title: "Research",
        updatedAt: 1,
        workflow,
        messages: [
          {
            id: "m",
            role: "assistant",
            text: "running",
            status: "streaming",
            workflowRunId: "run-1",
            workflowPhase: "running",
          },
        ],
      },
    ],
  });
  assert.deepEqual(restored.sessions[0].workflow, workflow);
  assert.equal(restored.sessions[0].messages[0].workflowRunId, "run-1");
  assert.equal(restored.sessions[0].messages[0].workflowPhase, "running");
  assert.deepEqual(restored.hiddenWorkflowRuns, [
    "http://localhost:4311/removed",
  ]);
});

test("ordinary messages cannot acquire workflow references without a valid binding", () => {
  const restored = restoreState({
    version: 1,
    sessions: [
      {
        id: "s",
        title: "chat",
        updatedAt: 1,
        workflow: {
          id: "f",
          title: "f",
          endpoint: "https://user:secret@example.com",
        },
        messages: [
          {
            id: "m",
            role: "assistant",
            text: "hello",
            status: "complete",
            workflowRunId: "r",
            workflowPhase: "running",
          },
        ],
      },
    ],
  });
  assert.equal(restored.sessions[0].workflow, undefined);
  assert.equal(restored.sessions[0].messages[0].workflowRunId, undefined);
  assert.equal(restored.sessions[0].messages[0].workflowPhase, undefined);
});
