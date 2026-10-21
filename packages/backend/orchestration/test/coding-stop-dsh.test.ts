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
 * Stopping must not depend on the client's stream: the turn here keeps its
 * own signal alive (as after a page reload, or a proxy that holds the
 * upstream open), and only `stopCoding` ends it. The model asks a question so
 * the turn reliably waits until it is stopped.
 */
test(
  "stopCoding ends a running turn without the client disconnecting",
  {
    timeout: 180_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-stop-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project, { recursive: true });
    await mkdir(flowRoot, { recursive: true });

    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      const currentTurn = request.messages.slice(
        request.messages.findLastIndex((message) => message.role === "user"),
      );
      const call = !currentTurn.some((message) => message.role === "tool");
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
                                  id: "go",
                                  question: "继续吗？",
                                  options: [{ label: "是" }, { label: "否" }],
                                },
                              ],
                            }),
                          },
                        },
                      ],
                    }
                  : { content: "好的" },
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
      const created = await host.createProject(project, "stop");
      const sessionId = "coding-stop-session";
      let asked: () => void = () => {};
      const question = new Promise<void>((resolve) => {
        asked = resolve;
      });
      const send = (prompt: string, emit: (e: CodingStreamEvent) => void) =>
        host.coding(
          {
            sessionId,
            projectId: created.id,
            prompt,
            mode: "demo",
            model: "deepseek-v4-flash",
            reasoningEffort: "off",
          },
          emit,
          // Never aborted by the test: only stopCoding may end the turn.
          AbortSignal.timeout(150_000),
        );
      const turn = send("开始", (event) => {
        if (event.type === "question") asked();
      });
      const settled = turn.then(
        () => "resolved",
        () => "rejected",
      );
      await Promise.race([
        question,
        settled.then(() => {
          throw new Error("The turn ended before asking a question");
        }),
      ]);

      // Another id is never stopped by mistake.
      assert.deepEqual(await host.stopCoding("coding-other"), {
        stopped: false,
      });
      assert.deepEqual(await host.stopCoding(sessionId), { stopped: true });
      assert.equal(await settled, "rejected", "the stopped turn must end");

      // Nothing left to stop, and the stored turn is not left running.
      assert.deepEqual(await host.stopCoding(sessionId), { stopped: false });
      const history = await host.codingHistory(sessionId);
      assert.equal(history.running, false);
      assert.notEqual(history.turns.at(-1)?.status, "running");

      // Stop is per turn, not per conversation: the next turn still runs.
      let again: () => void = () => {};
      const nextQuestion = new Promise<void>((resolve) => {
        again = resolve;
      });
      const next = send("再试一次", (event) => {
        if (event.type === "question") again();
      });
      const nextSettled = next.then(
        () => "resolved",
        () => "rejected",
      );
      await Promise.race([
        nextQuestion,
        nextSettled.then(() => {
          throw new Error("The next turn ended before asking a question");
        }),
      ]);
      assert.deepEqual(await host.stopCoding(sessionId), { stopped: true });
      assert.equal(await nextSettled, "rejected");
    } finally {
      await host.close?.();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
