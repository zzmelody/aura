import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { FlowRun, FlowRunSummary } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";

test(
  "conversations run flows, read restored results and receive checkpoint diagnostics",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-flow-conversation-"));
    let host: OrchestrationHost;
    let server: ServerType | undefined;
    t.after(async () => {
      await host?.close();
      const currentServer = server;
      server = undefined;
      if (currentServer)
        await new Promise<void>((resolve, reject) =>
          currentServer.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(root, { recursive: true, force: true });
    });
    const flowRoot = join(root, "flow");
    await mkdir(join(flowRoot, "report"), { recursive: true });
    await writeFile(
      join(flowRoot, "report", "report.flow.ts"),
      `
import { defineFlow, z } from ${JSON.stringify(new URL("../src/flow-api.ts", import.meta.url).href)};
export default defineFlow({
  title: "Synthetic report",
  description: "Local integration fixture; no external model or paid service",
  input: z.object({ topic: z.string() }),
  output: z.object({ report: z.string() }),
  async run(ctx, input) {
    if (input.topic === "CHECKPOINT") {
      await ctx.sequence({ id: "review" }, (scope) =>
        scope.checkpoint({
          id: "confirm",
          label: "报告审核",
          prompt: "请审核报告后继续。",
          schema: z.boolean(),
        }),
      );
    }
    return { report: "Report for " + input.topic };
  }
});
`,
    );
    let calls = 0;
    let queriedRun = "";
    let checkpointContext = "";
    const requestedTools: string[] = [];
    const model = new Hono();
    model.post("/v1/chat/completions", async (context) => {
      const request = await context.req.json<{
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      }>();
      requestedTools.push(
        ...(request.tools?.map((tool) => tool.function.name) ?? []),
      );
      const lastRequest = request.messages.findLastIndex(
        (message) => message.role === "user",
      );
      const prompt =
        JSON.stringify(request.messages[lastRequest]?.content) ?? "";
      const answered = request.messages
        .slice(lastRequest + 1)
        .some((message) => message.role === "tool");
      const check = prompt.includes("CHECK_RESULT");
      const checkpoint = prompt.includes("RUN_CHECKPOINT");
      if (checkpoint && answered)
        checkpointContext = JSON.stringify(
          request.messages
            .slice(lastRequest + 1)
            .filter((message) => message.role === "tool"),
        );
      const call = !answered;
      return streamSSE(context, async (stream) => {
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: call
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: `flow-call-${++calls}`,
                          type: "function",
                          function: {
                            name: check ? "aura_flow_status" : "aura_run_flow",
                            arguments: JSON.stringify(
                              check
                                ? { runId: queriedRun }
                                : {
                                    flowId: "report",
                                    input: {
                                      topic: checkpoint ? "CHECKPOINT" : "Aura",
                                    },
                                  },
                            ),
                          },
                        },
                      ],
                    }
                  : { content: "已处理，可以继续讨论。" },
                finish_reason: null,
              },
            ],
          }),
        });
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: call ? "tool_calls" : "stop",
              },
            ],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
      });
    });
    server = serve({ fetch: model.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening)
      await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${address.port}/v1`,
    };
    host = new OrchestrationHost(options);
    const conversationId = "coding-flow-discussion";
    const send = (prompt: string) =>
      host.coding(
        {
          sessionId: conversationId,
          prompt,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        () => {},
        AbortSignal.timeout(60_000),
      );
    await send("RUN_FLOW 请运行报告工作流");
    const runs = await host.request<FlowRunSummary[]>("list");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.conversationId, conversationId);
    queriedRun = runs[0]!.id;
    assert.deepEqual(
      (await host.request<FlowRun>("get", { id: queriedRun })).output,
      { report: "Report for Aura" },
    );
    const first = await host.codingHistory(conversationId);
    assert.ok(
      first.turns[0]?.events.some(
        (event) => event.type === "workflow" && event.runId === queriedRun,
      ),
    );
    assert.ok(requestedTools.includes("aura_flow_catalog"));
    assert.ok(requestedTools.includes("aura_run_flow"));
    assert.ok(requestedTools.includes("aura_flow_status"));

    await host.close();
    host = new OrchestrationHost(options);
    const restored = await host.codingHistory(conversationId);
    assert.ok(
      restored.turns[0]?.events.some(
        (event) => event.type === "workflow" && event.runId === queriedRun,
      ),
    );
    await send("CHECK_RESULT 继续讨论刚才的结果，不要重新执行");
    assert.equal((await host.request<FlowRunSummary[]>("list")).length, 1);
    await send("RUN_FLOW 明确要求再运行一次");
    const repeated = await host.request<FlowRunSummary[]>("list");
    assert.equal(repeated.length, 2);
    assert.ok(repeated.every((run) => run.conversationId === conversationId));
    assert.notEqual(repeated[0]?.id, repeated[1]?.id);
    assert.equal((await host.codingHistory(conversationId)).turns.length, 3);

    await send("RUN_CHECKPOINT 生成需要审核的报告");
    const waiting = (await host.request<FlowRunSummary[]>("list")).find(
      (run) => run.status === "waiting_input",
    );
    assert.ok(waiting);
    assert.ok(checkpointContext.includes(waiting.id));
    assert.match(
      checkpointContext,
      /waiting_input.*报告审核.*请审核报告后继续/u,
    );
  },
);
