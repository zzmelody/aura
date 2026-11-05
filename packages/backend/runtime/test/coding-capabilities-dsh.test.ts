import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/dsh/host.ts";

test(
  "native delegation restricts children, accounts requests and restores child results without resubmission",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-capabilities-"));
    let host: OrchestrationHost;
    let closeServer: (() => Promise<void>) | undefined;
    t.after(async () => {
      try {
        await host?.close();
      } finally {
        try {
          await closeServer?.();
        } finally {
          await rm(root, { recursive: true, force: true, maxRetries: 3 });
        }
      }
    });
    const flowRoot = join(root, "flow");
    const project = join(root, "project");
    await mkdir(flowRoot);
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "DELEGATED_WORKSPACE_RULES\n");
    const calls: string[][] = [];
    const childPrompts: string[] = [];
    const toolResults: unknown[] = [];
    let titleRequests = 0;
    let holdChild = false;
    let escapeChild = false;
    let childStarted!: () => void;
    const childReady = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const app = new Hono();
    app.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as {
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const names = request.tools?.map((tool) => tool.function.name) ?? [];
      const title =
        !names.length &&
        JSON.stringify(request.messages).includes("为对话提炼");
      if (title) titleRequests++;
      else calls.push(names);
      toolResults.push(
        ...request.messages.filter((message) => message.role === "tool"),
      );
      const child = !title && !names.includes("write");
      if (child) childPrompts.push(JSON.stringify(request.messages));
      const ask =
        child &&
        names.includes("ask_user_question") &&
        !request.messages.some((message) => message.role === "tool");
      const spawn =
        !child &&
        request.messages.some(
          (message) => message.content === "Delegate a review.",
        ) &&
        !request.messages.some((message) => message.role === "tool");
      return streamSSE(context, async (stream) => {
        if (child && holdChild) {
          childStarted();
          await new Promise<void>((resolve) => stream.onAbort(resolve));
          return;
        }
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: ask
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "child-question",
                          type: "function",
                          function: {
                            name: "ask_user_question",
                            arguments: JSON.stringify({
                              questions: [
                                {
                                  id: "review-scope",
                                  question: "Review all files?",
                                  options: [{ label: "Yes" }, { label: "No" }],
                                },
                              ],
                            }),
                          },
                        },
                      ],
                    }
                  : spawn
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: "delegate-1",
                            type: "function",
                            function: {
                              name: "subagent",
                              arguments: JSON.stringify({
                                prompt:
                                  "Review the project without changing files.",
                                description: "Synthetic review",
                                agent_preset: "coding-reviewer",
                                ...(escapeChild ? { cwd: "/" } : {}),
                              }),
                            },
                          },
                        ],
                      }
                    : {
                        content: title
                          ? "调研项目方案"
                          : child
                            ? "Synthetic child review complete."
                            : "Synthetic parent complete.",
                      },
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
                finish_reason: spawn || ask ? "tool_calls" : "stop",
              },
            ],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
      });
    });
    const port = await new Promise<number>((resolve) => {
      const server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(port),
      );
      closeServer = () =>
        new Promise<void>((done, reject) => {
          if ("closeAllConnections" in server) server.closeAllConnections();
          server.close((error) => (error ? reject(error) : done()));
        });
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    host = new OrchestrationHost(options);
    const created = await host.createProject(project, "Synthetic");
    await host.codingCapabilities({
      revision: 0,
      autoCompact: false,
      web: false,
      subagents: true,
      maxRequests: 10,
    });
    const events: unknown[] = [];
    const answers: Array<Promise<unknown>> = [];
    await host.coding(
      {
        sessionId: "coding-native-child",
        projectId: created.id,
        mode: "demo",
        prompt: "Delegate a review.",
        model: "deepseek-v4-flash",
        reasoningEffort: "off",
      },
      (event) => {
        events.push(event);
        if (event.type === "question") {
          assert.match(event.questions[0]?.header ?? "", /子 Agent/u);
          answers.push(
            host.answerCoding("coding-native-child", event.questionId, [
              { id: "review-scope", selected: ["Yes"] },
            ]),
          );
        }
      },
      AbortSignal.timeout(60_000),
    );
    await Promise.all(answers);
    assert.equal(answers.length, 1, JSON.stringify({ calls, toolResults }));
    assert.ok(calls[0]?.includes("subagent"));
    const children = await host.codingSubagents("coding-native-child");
    assert.equal(children.length, 1, JSON.stringify(events));
    assert.equal(children[0]?.status, "complete");
    assert.match(children[0]!.result, /child review complete/u);
    const childCalls = calls.filter((names) => !names.includes("write"));
    assert.ok(childCalls.length > 0);
    for (const prompt of childPrompts)
      assert.match(prompt, /DELEGATED_WORKSPACE_RULES/u);
    assert.ok(
      childCalls.every(
        (names) =>
          !names.some((name) =>
            ["edit", "bash", "pwsh", "subagent", "schedule_create"].includes(
              name,
            ),
          ),
      ),
    );
    assert.equal(
      (await host.codingCapabilities()).usedRequests,
      childCalls.length + titleRequests,
    );
    const compacted = await host.compactCoding("coding-native-child");
    assert.equal(compacted.compacted, true);
    assert.ok(compacted.replacedMessages > 0);
    assert.equal(
      (await host.codingCapabilities()).usedRequests,
      childCalls.length + titleRequests + 1,
    );
    const history = await host.codingHistory("coding-native-child");
    assert.ok(JSON.stringify(history).includes("Delegate a review."));
    const saved = await host.codingCapabilities();
    await host.codingCapabilities({
      revision: saved.revision,
      autoCompact: true,
      web: true,
      key: "synthetic-web-test-key",
      subagents: true,
      maxRequests: 30,
    });
    const automatic: unknown[] = [];
    for (let index = 0; index < 3; index++)
      await host.coding(
        {
          sessionId: "coding-native-child",
          projectId: created.id,
          mode: "demo",
          prompt: `Long turn ${index}: ` + "synthetic context ".repeat(4000),
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        (event) => automatic.push(event),
        AbortSignal.timeout(30_000),
      );
    assert.ok(calls.at(-1)?.includes("web_search"));
    assert.ok(calls.at(-1)?.includes("web_fetch"));
    assert.ok(
      automatic.some((event) => (event as { type: string }).type === "notice"),
    );
    await host.close();
    const count = calls.length;
    host = new OrchestrationHost(options);
    assert.equal(
      (await host.codingSubagents("coding-native-child"))[0]?.status,
      "complete",
    );
    assert.equal(calls.length, count);
    assert.equal(
      (await host.compactCoding("coding-native-child")).compacted,
      true,
    );
    escapeChild = true;
    await host.coding(
      {
        sessionId: "coding-no-escape",
        projectId: created.id,
        mode: "demo",
        prompt: "Delegate a review.",
        model: "deepseek-v4-flash",
        reasoningEffort: "off",
      },
      () => {},
      AbortSignal.timeout(30_000),
    );
    assert.equal((await host.codingSubagents("coding-no-escape")).length, 0);
    escapeChild = false;
    // An empty side has nothing to summarize and consumes no allowance.
    const side = await host.request<{ sessionId: string }>("coding/side/open", {
      sessionId: "coding-native-child",
    });
    const before = (await host.codingCapabilities()).usedRequests;
    assert.equal((await host.compactCoding(side.sessionId)).compacted, false);
    assert.equal((await host.codingCapabilities()).usedRequests, before);
    // Stopping the parent must release a child even after the parent's own turn ended.
    holdChild = true;
    const pending = host.coding(
      {
        sessionId: "coding-cancel-child",
        projectId: created.id,
        mode: "demo",
        prompt: "Delegate a review.",
        model: "deepseek-v4-flash",
        reasoningEffort: "off",
      },
      () => {},
      AbortSignal.timeout(30_000),
    );
    const rejected = assert.rejects(pending);
    await childReady;
    await assert.rejects(host.compactCoding("coding-cancel-child"));
    assert.equal((await host.stopCoding("coding-cancel-child")).stopped, true);
    await rejected;
    assert.ok(
      (await host.codingSubagents("coding-cancel-child")).every(
        (child) => child.status !== "running",
      ),
    );
    assert.equal((await host.codingCapabilities()).unknownRequests, 1);
  },
);
