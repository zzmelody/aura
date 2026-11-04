import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ChatWorkflowStart, FlowRun } from "@aura/protocol/types";
import {
  chatTools,
  requestIdFor,
  type ChatToolHost,
} from "../src/chat-tools.ts";
import { FlowError } from "../src/schema.ts";

function call(
  tool: ToolDefinition,
  args: unknown,
  id: string,
  signal = new AbortController().signal,
) {
  return tool.execute(args, {
    callId: ToolCallId(id),
    rootCallId: ToolCallId(id),
    // Synthetic identity: these focused tests exercise tool bodies, not dispatch.
    token: Symbol(id) as ToolRunContext["token"],
    name: tool.name,
    arguments: args,
    signal,
    deferContext() {},
    concludeTurn() {},
  });
}

function fixture() {
  const runs: FlowRun[] = [];
  const starts: Array<Parameters<ChatToolHost["start"]>[0]> = [];
  const cards: ChatWorkflowStart[] = [];
  const host: ChatToolHost = {
    async catalog() {
      return {
        presets: [],
        flows: [
          {
            id: "studio/report",
            title: "报告",
            description: "合成测试 Flow",
            available: true,
            inputSchema: { type: "object" },
          },
          {
            id: "unavailable",
            title: "不可用",
            description: "",
            available: false,
            error: "private details",
          },
        ],
      };
    },
    async start(input) {
      starts.push(input);
      const run: FlowRun = {
        id: `run-${runs.length + 1}`,
        requestId: input.requestId,
        flow: {
          id: input.flowId,
          title: "报告",
          description: "",
          sourceHash: "hash",
        },
        input: input.input as FlowRun["input"],
        mode: input.mode,
        status: "running",
        createdAt: 1,
        steps: [],
      };
      runs.push(run);
      return run;
    },
    get(id) {
      const run = runs.find((item) => item.id === id);
      if (!run) throw new FlowError("运行不存在。", 404);
      return run;
    },
  };
  const tools = chatTools(host, {
    mode: "demo",
    signal: new AbortController().signal,
    started: (run) => cards.push(run),
    waitMs: 0,
  });
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  return { host, starts, runs, cards, tool };
}

test("conversations discover every available flow without exposing failed discovery details", async () => {
  const { tool } = fixture();
  assert.deepEqual(await call(tool("aura_flow_catalog"), {}, "catalog"), [
    {
      id: "studio/report",
      title: "报告",
      description: "合成测试 Flow",
      inputSchema: { type: "object" },
    },
  ]);
});

test("one tool call starts one durable flow and explicit repetition creates an independent run", async () => {
  const { starts, cards, tool } = fixture();
  const args = {
    flowId: "studio/report",
    input: { topic: "Aura" },
    mode: "custom",
  };
  const first = await call(tool("aura_run_flow"), args, "first");
  assert.deepEqual(await call(tool("aura_run_flow"), args, "first"), first);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], {
    requestId: requestIdFor("first"),
    flowId: args.flowId,
    input: args.input,
    mode: "custom",
  });
  await call(tool("aura_run_flow"), args, "repeat");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0]?.requestId, starts[1]?.requestId);
  assert.deepEqual(
    cards.map((run) => run.runId),
    ["run-1", "run-2"],
  );
});

test("follow-up questions read a run's latest result without re-executing it", async () => {
  const { runs, starts, tool } = fixture();
  await call(
    tool("aura_run_flow"),
    { flowId: "studio/report", input: { topic: "Aura" } },
    "first",
  );
  runs[0]!.status = "completed";
  runs[0]!.output = { report: "这是完成后的结果。" };
  assert.deepEqual(
    await call(tool("aura_flow_status"), { runId: "run-1" }, "read"),
    {
      runId: "run-1",
      status: "completed",
      input: { topic: "Aura" },
      output: JSON.stringify(runs[0]!.output),
    },
  );
  assert.equal(starts.length, 1);
  await assert.rejects(
    call(tool("aura_flow_status"), { runId: "missing" }, "missing"),
    /运行不存在/u,
  );
});

test("conversation status explains the blocking step inside a child Run", async () => {
  const { host, runs, tool } = fixture();
  const root = await host.start({
    requestId: "request",
    flowId: "report",
    input: null,
    mode: "demo",
  });
  root.status = "needs_attention";
  root.steps = [
    {
      id: "child",
      stepKey: "main/child",
      kind: "flow",
      label: "生成报告",
      status: "unknown",
      flowId: "render",
      sourceHash: "hash",
      input: null,
      outputSchema: {},
      childRequestId: "child-request",
      childRunId: "child-run",
      requestInputHash: "hash",
    },
  ];
  const child: FlowRun = {
    ...root,
    id: "child-run",
    parent: { runId: root.id, stepKey: "main/child" },
    steps: [
      {
        id: "render",
        kind: "action",
        label: "渲染",
        status: "unknown",
        actionId: "render",
        input: { internal: "private step input" },
        error: "渲染过程中断，结果未知。",
      },
    ],
  };
  runs.push(child);
  const args = { runId: root.id };
  const result = await call(tool("aura_flow_status"), args, "unknown");
  assert.partialDeepStrictEqual(result, {
    status: "needs_attention",
    steps: [
      {
        stepKey: "main/child",
        childRunId: child.id,
        childStatus: "needs_attention",
      },
      {
        runId: child.id,
        stepKey: "render",
        actionId: "render",
        error: "渲染过程中断，结果未知。",
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /private step input/u);

  root.status = child.status = "waiting_input";
  root.steps[0]!.status = "waiting_input";
  child.steps = [
    {
      id: "review",
      kind: "checkpoint",
      label: "人工审核",
      status: "waiting_input",
      prompt: "请确认草稿。",
      outputSchema: { type: "boolean" },
    },
  ];
  assert.partialDeepStrictEqual(
    await call(tool("aura_flow_status"), args, "waiting"),
    {
      status: "waiting_input",
      steps: [
        { childStatus: "waiting_input" },
        { stepKey: "review", prompt: "请确认草稿。" },
      ],
    },
  );
});

test("start tool distinguishes retry backoff and storage failure from ordinary execution", async () => {
  const { host, tool } = fixture();
  const start = host.start;
  host.start = async (input) => {
    const run = await start(input);
    const now = Date.now();
    run.steps = [
      {
        id: "retry",
        kind: "action",
        label: "等待重试",
        status: "queued",
        actionId: "render",
        input: null,
        nextAttemptAt: now + 60_000,
        attempts: [
          {
            number: 1,
            status: "failed",
            startedAt: now,
            error: "服务暂时不可用。",
          },
        ],
      },
    ];
    return run;
  };
  const result = await call(
    tool("aura_run_flow"),
    { flowId: "report", input: null },
    "progress",
  );
  assert.partialDeepStrictEqual(result, {
    status: "running",
    steps: [
      {
        stepKey: "retry",
        status: "queued",
        error: "服务暂时不可用。",
        attempt: 1,
      },
    ],
  });
  assert.match(JSON.stringify(result), /"retryInMs":[1-9]\d*/u);

  host.storageIssue = () => "Flow 状态存档失败，请修复存储并重启运行时恢复。";
  const blocked = await call(
    tool("aura_flow_status"),
    { runId: "run-1" },
    "blocked",
  );
  assert.partialDeepStrictEqual(blocked, {
    status: "running",
    error: "Flow 状态存档失败，请修复存储并重启运行时恢复。",
  });
  assert.doesNotMatch(JSON.stringify(blocked), /"note"/u);
});

test("uncertain submissions cannot start another flow automatically or leak upstream errors", async () => {
  const { host, starts, tool } = fixture();
  host.start = async (input) => {
    starts.push(input);
    throw new Error("secret upstream response");
  };
  const args = { flowId: "studio/report", input: null };
  const first = await call(tool("aura_run_flow"), args, "uncertain");
  assert.match(JSON.stringify(first), /unknown/u);
  assert.doesNotMatch(JSON.stringify(first), /secret upstream/u);
  await call(tool("aura_run_flow"), args, "automatic-retry");
  assert.equal(starts.length, 1);
});

test("cancelled requests never start external flow work", async () => {
  const { starts, tool } = fixture();
  await call(
    tool("aura_run_flow"),
    { flowId: "studio/report", input: null },
    "cancelled",
    AbortSignal.abort(),
  );
  assert.equal(starts.length, 0);
});

test("an accepted Run remains replayable when reading its result fails", async () => {
  const { host, starts, tool } = fixture();
  host.get = () => {
    throw new Error("temporary read failure");
  };
  const result = (await call(
    tool("aura_run_flow"),
    { flowId: "studio/report", input: {} },
    "accepted",
  )) as {
    status: string;
    workflow: { runId: string };
  };
  assert.equal(result.status, "unknown");
  assert.equal(result.workflow.runId, "run-1");
  await call(
    tool("aura_run_flow"),
    { flowId: "studio/report", input: {} },
    "retry",
  );
  assert.equal(starts.length, 1);
});
