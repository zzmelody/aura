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
