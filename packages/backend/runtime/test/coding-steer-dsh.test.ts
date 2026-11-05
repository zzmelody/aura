import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import sharp from "sharp";
import { OrchestrationHost } from "../src/dsh/host.ts";
import type { CodingStreamEvent } from "@aura/agent-runtime";

const nodeMajor = Number(process.versions.node.split(".")[0]);

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}

/** The guidance the test sends into the running turn. */
const GUIDANCE = "改用 map 实现";
/** Tool calls allowed before the model gives up waiting for guidance. */
const MAX_STEPS = 12;

/** Whether a message's content holds the given text, in any block shape. */
function mentions(content: unknown, text: string): boolean {
  if (typeof content === "string") return content.includes(text);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const value = (part as { text?: unknown } | null)?.text;
    return typeof value === "string" && value.includes(text);
  });
}

/**
 * Steering reaches a turn that is already running: DSH joins the message to
 * that turn, whose next step claims it, so the model reads the guidance
 * without the turn restarting. The turn's own stream keeps carrying the work,
 * which is where the guidance shows up as a transcript entry.
 *
 * The model here loops on a read-only tool until it sees the guidance, so the
 * turn is reliably still running when the test sends it.
 */
test(
  "steerCoding joins guidance to the running turn and the model reads it",
  {
    timeout: 180_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-steer-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project, { recursive: true });
    await mkdir(flowRoot, { recursive: true });

    /** Set once the model's prompt contained the guidance. */
    const firstRequest = Promise.withResolvers<void>();
    const firstReply = Promise.withResolvers<void>();
    const models: string[] = [];
    let sawGuidance = false;
    const guidedModels: string[] = [];
    let steps = 0;
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      models.push(request.model);
      if (models.length === 1) {
        firstRequest.resolve();
        await firstReply.promise;
      }
      const guided = request.messages.some(
        (message) =>
          message.role === "user" && mentions(message.content, GUIDANCE),
      );
      if (guided) {
        sawGuidance = true;
        guidedModels.push(request.model);
      }
      // Keep the turn alive with a harmless step until the guidance lands.
      const call = !guided && steps++ < MAX_STEPS;
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
                          id: `glob_${steps}`,
                          type: "function",
                          function: {
                            name: "glob",
                            arguments: JSON.stringify({ pattern: "*" }),
                          },
                        },
                      ],
                    }
                  : { content: guided ? "按引导改好了" : "没有收到引导" },
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
      const created = await host.createProject(project, "steer");
      const sessionId = "coding-steer-session";
      const events: CodingStreamEvent[] = [];
      const turn = host.coding(
        {
          sessionId,
          projectId: created.id,
          prompt: "写个函数",
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        (event) => {
          events.push(event);
        },
        AbortSignal.timeout(150_000),
      );
      const settled = turn.then(
        () => "resolved",
        () => "rejected",
      );
      await Promise.race([
        firstRequest.promise,
        settled.then(() => {
          throw new Error("The turn ended before taking a step");
        }),
      ]);

      // Another id is never steered by mistake, and an unknown conversation
      // is reported rather than started.
      assert.deepEqual(await host.steerCoding("coding-other", GUIDANCE), {
        steered: false,
      });
      // Model controls can stage a choice while the current call is still running.
      await host.selectConversationModel(sessionId, "demo", {
        model: "deepseek-v4-pro",
        reasoningEffort: "off",
      });
      await assert.rejects(
        host.steerCoding(sessionId, "cross-service guidance", undefined, {
          mode: "codex",
          selection: { model: "gpt-6.1-sol" },
        }),
        /当前模型服务/u,
      );
      await assert.rejects(
        host.steerCoding(sessionId, "bad effort", undefined, {
          mode: "demo",
          selection: {
            model: "deepseek-v4-pro",
            reasoningEffort: "unsupported",
          },
        }),
        /不可用/u,
      );
      const image = await host.uploadImage(
        await sharp({
          create: { width: 2, height: 2, channels: 3, background: "blue" },
        })
          .png()
          .toBuffer(),
        AbortSignal.timeout(10_000),
      );
      await assert.rejects(
        host.steerCoding(sessionId, "看看图片", [image.artifactId], {
          mode: "demo",
          selection: { model: "deepseek-v4-pro", reasoningEffort: "off" },
        }),
        /不支持图片输入/u,
      );
      const requestId = "00000000-0000-4000-8000-000000000001";
      assert.deepEqual(
        await host.steerCoding(
          sessionId,
          GUIDANCE,
          undefined,
          {
            mode: "demo",
            selection: { model: "deepseek-v4-pro", reasoningEffort: "off" },
          },
          requestId,
        ),
        { steered: true },
      );

      assert.deepEqual(
        models,
        ["deepseek-v4-flash"],
        "the in-flight call keeps its original model",
      );
      assert.equal(
        events.some((event) => event.type === "steer"),
        false,
        "admission succeeds before the agent records guidance on the stream",
      );
      firstReply.resolve();
      assert.equal(await settled, "resolved", "the steered turn must finish");
      assert.ok(sawGuidance, "the model must read the guidance");
      assert.ok(guidedModels.length > 0);
      assert.ok(
        guidedModels.every((model) => model === "deepseek-v4-pro"),
        "guidance uses the newly selected model",
      );
      assert.equal(
        (await host.conversations(created.id))[0]?.modelConfig?.demo?.model,
        "deepseek-v4-pro",
      );
      // One turn, not two: steering never opens its own.
      const history = await host.codingHistory(sessionId);
      assert.equal(history.turns.length, 1);
      const transcript = JSON.stringify(history);
      assert.ok(!transcript.includes("cross-service guidance"));
      assert.ok(!transcript.includes("bad effort"));
      assert.ok(!transcript.includes("看看图片"));
      assert.equal(history.turns[0]!.prompt, "写个函数");
      assert.equal(history.turns[0]!.status, "complete");
      // The guidance shows in the transcript, live and replayed alike.
      // Both carry the same session event time, so the trajectory agrees.
      const live = events.filter((event) => event.type === "steer");
      assert.equal(live.length, 1);
      assert.equal(live[0]!.text, GUIDANCE);
      assert.equal(live[0]!.requestId, requestId);
      assert.equal(typeof live[0]!.at, "number");
      assert.deepEqual(
        history.turns[0]!.events.filter((event) => event.type === "steer"),
        live,
      );

      // A conversation whose turn has ended takes no more guidance.
      assert.deepEqual(await host.steerCoding(sessionId, GUIDANCE), {
        steered: false,
      });
    } finally {
      firstReply.resolve();
      await host.close?.();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
