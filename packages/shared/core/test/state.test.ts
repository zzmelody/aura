import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, restoreState, validateEndpoint } from "@aura/core";

test("archive metadata and sidebar width restore without dropping history", () => {
  const message = {
    id: "m",
    role: "assistant",
    text: "report",
    status: "complete",
  };
  const restored = restoreState({
    version: 1,
    sidebarWidth: 352,
    sessions: [
      {
        id: "archived",
        title: "Report",
        updatedAt: 1,
        archivedAt: 12,
        messages: [message],
      },
      { id: "legacy", title: "Old conversation", updatedAt: 1, messages: [] },
      {
        id: "invalid",
        title: "Invalid marker",
        updatedAt: 1,
        archivedAt: -1,
        messages: [],
      },
    ],
  });
  assert.equal(restored.sidebarWidth, 352);
  assert.equal(restored.sessions[0].archivedAt, 12);
  assert.equal(restored.sessions[0].messages[0].text, "report");
  assert.equal(restored.sessions[1].archivedAt, undefined);
  assert.equal(restored.sessions[2].archivedAt, undefined);
  assert.equal(
    restoreState({ version: 1, sessions: [], sidebarWidth: 99999 })
      .sidebarWidth,
    480,
  );
  assert.equal(
    restoreState({ version: 1, sessions: [], sidebarWidth: 1 }).sidebarWidth,
    240,
  );
  assert.equal(
    restoreState({ version: 1, sessions: [], sidebarWidth: "300" })
      .sidebarWidth,
    undefined,
  );
});

test("chat model choices survive reload independently without leaking into bound Flows", () => {
  const first = {
    codex: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
    demo: { reasoningEffort: "off" },
  };
  const second = { codex: { model: "gpt-5.6-terra", reasoningEffort: "high" } };
  const session = { title: "chat", updatedAt: 1, messages: [] };
  const state = restoreState({
    version: 1,
    sessions: [
      { ...session, id: "one", modelConfig: first },
      { ...session, id: "two", modelConfig: second },
      { ...session, id: "legacy" },
      {
        ...session,
        id: "flow",
        modelConfig: first,
        workflow: {
          id: "research",
          title: "Flow",
          endpoint: "http://localhost:4311",
        },
      },
      {
        ...session,
        id: "invalid",
        modelConfig: {
          codex: { model: "ok", apiKey: "secret" },
          demo: { reasoningEffort: "" },
          other: { model: "ok" },
        },
      },
    ],
  });
  assert.deepEqual(state.sessions[0]!.modelConfig, first);
  assert.deepEqual(state.sessions[1]!.modelConfig, second);
  assert.equal(state.sessions[2]!.modelConfig, undefined);
  assert.equal(state.sessions[3]!.modelConfig, undefined);
  assert.deepEqual(state.sessions[4]!.modelConfig, {});
  assert.doesNotMatch(JSON.stringify(state), /secret/);
});

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

test("ordinary conversations keep workflow runs referenced per message", () => {
  const restored = restoreState({
    version: 1,
    sessions: [
      {
        id: "chat",
        title: "plain",
        updatedAt: 1,
        pendingWorkflow: {
          id: "short-video",
          title: "短视频",
          endpoint: "http://127.0.0.1:4311",
          pending: { requestId: "r", input: { text: "x" }, mode: "demo" },
        },
        messages: [
          { id: "u", role: "user", text: "hi", status: "complete" },
          {
            id: "run:output",
            role: "assistant",
            text: "正在运行",
            status: "streaming",
            workflowRunId: "run",
            workflowPhase: "running",
            workflow: {
              id: "short-video",
              title: "短视频",
              endpoint: "http://127.0.0.1:4311",
            },
          },
          {
            id: "orphan",
            role: "assistant",
            text: "x",
            status: "complete",
            workflowRunId: "lost",
          },
        ],
      },
    ],
  });
  const [session] = restored.sessions;
  assert.equal(session.workflow, undefined);
  assert.equal(session.pendingWorkflow?.pending.requestId, "r");
  assert.equal(session.messages[1].workflowRunId, "run");
  assert.equal(session.messages[1].workflowPhase, "running");
  assert.equal(session.messages[1].workflow?.id, "short-video");
  assert.equal(session.messages[2].workflowRunId, undefined);
});

test("user image references survive restore; invalid ones are dropped", () => {
  const good = "a".repeat(64);
  const restored = restoreState({
    version: 1,
    sessions: [
      {
        id: "s",
        title: "t",
        updatedAt: 1,
        messages: [
          {
            id: "u",
            role: "user",
            text: "看图",
            status: "complete",
            images: [
              {
                assetId: good,
                mimeType: "image/png",
                width: 10,
                height: 8,
                name: "a.png",
              },
              { assetId: "bad", mimeType: "image/png" },
              { assetId: good, mimeType: "image/gif" },
            ],
          },
          {
            id: "a",
            role: "assistant",
            text: "好",
            status: "complete",
            images: [{ assetId: good, mimeType: "image/png" }],
          },
        ],
      },
    ],
  });
  const [user, assistant] = restored.sessions[0].messages;
  assert.deepEqual(user.images, [
    {
      assetId: good,
      mimeType: "image/png",
      width: 10,
      height: 8,
      name: "a.png",
    },
  ]);
  assert.equal(assistant.images, undefined);
});
