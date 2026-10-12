import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/index.ts";
import type { CodingStreamEvent } from "../src/types.ts";

const nodeMajor = Number(process.versions.node.split(".")[0]);

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * The fixture model asks one question through `ask_user_question` and, once
 * the tool result arrives, replies with whatever the tool returned. The test
 * answers as the user would, so it covers the agent-scoped answerer, the
 * pending store, and the answer reaching the model.
 */
test(
  "a coding agent's question waits for the user's answer and gets it back",
  {
    timeout: 180_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-ask-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project, { recursive: true });
    await mkdir(flowRoot, { recursive: true });

    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      const result = request.messages.findLast((m) => m.role === "tool");
      const call = !result;
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: call
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "ask_call",
                          type: "function",
                          function: {
                            name: "ask_user_question",
                            arguments: JSON.stringify({
                              questions: [
                                {
                                  id: "style",
                                  question: "用哪种写法？",
                                  options: [
                                    { label: "函数式" },
                                    { label: "类" },
                                  ],
                                },
                              ],
                            }),
                          },
                        },
                      ],
                    }
                  : { content: `收到：${String(result.content)}` },
                finish_reason: null,
              },
            ],
          }),
        });
        await output.writeSSE({
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
        await output.writeSSE({ data: "[DONE]" });
      });
    });

    let model!: ServerType;
    const port = await new Promise<number>((done, fail) => {
      model = serve(
        { fetch: modelApp.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => done(port),
      );
      model.once("error", fail);
    });
    const host = new OrchestrationHost({
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    });

    try {
      const created = await host.createProject(project, "ask");
      const events: CodingStreamEvent[] = [];
      let asked: (event: CodingStreamEvent) => void = () => {};
      const question = new Promise<CodingStreamEvent>((resolve) => {
        asked = resolve;
      });
      const turn = host.coding(
        {
          sessionId: "ask-session",
          projectId: created.id,
          prompt: "帮我写一个工具函数",
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        (event) => {
          events.push(event);
          if (event.type === "question") asked(event);
        },
        AbortSignal.timeout(150_000),
      );

      const event = await question;
      assert.equal(event.type, "question");
      if (event.type !== "question") return;
      assert.equal(event.questions[0]!.question, "用哪种写法？");
      assert.deepEqual(
        event.questions[0]!.options?.map((option) => option.label),
        ["函数式", "类"],
      );

      // The wrong session cannot answer; the right one can, exactly once.
      await assert.rejects(
        host.answerCoding("other-session", event.questionId, []),
      );
      await host.answerCoding("ask-session", event.questionId, [
        { id: "style", selected: ["类"] },
      ]);
      await assert.rejects(
        host.answerCoding("ask-session", event.questionId, []),
      );

      await turn;
      const reply = events
        .filter((item) => item.type === "delta")
        .map((item) => (item.type === "delta" ? item.text : ""))
        .join("");
      assert.match(reply, /收到：/u);
      assert.match(reply, /类/u);
    } finally {
      await host.close?.();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
