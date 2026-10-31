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
    let sawGuidance = false;
    let steps = 0;
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      const guided = request.messages.some(
        (message) =>
          message.role === "user" && mentions(message.content, GUIDANCE),
      );
      if (guided) sawGuidance = true;
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
      let running: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        running = resolve;
      });
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
          // The first finished step proves the turn is live and stepping.
          if (event.type === "tool" && event.phase === "end") running();
        },
        AbortSignal.timeout(150_000),
      );
      const settled = turn.then(
        () => "resolved",
        () => "rejected",
      );
      await Promise.race([
        started,
        settled.then(() => {
          throw new Error("The turn ended before taking a step");
        }),
      ]);

      // Another id is never steered by mistake, and an unknown conversation
      // is reported rather than started.
      assert.deepEqual(await host.steerCoding("coding-other", GUIDANCE), {
        steered: false,
      });
      assert.deepEqual(await host.steerCoding(sessionId, GUIDANCE), {
        steered: true,
      });

      assert.equal(await settled, "resolved", "the steered turn must finish");
      assert.ok(sawGuidance, "the model must read the guidance");
      // One turn, not two: steering never opens its own.
      const history = await host.codingHistory(sessionId);
      assert.equal(history.turns.length, 1);
      assert.equal(history.turns[0]!.prompt, "写个函数");
      assert.equal(history.turns[0]!.status, "complete");
      // The guidance shows in the transcript, live and replayed alike.
      // Both carry the same session event time, so the trajectory agrees.
      const live = events.filter((event) => event.type === "steer");
      assert.equal(live.length, 1);
      assert.equal(live[0]!.text, GUIDANCE);
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
      await host.close?.();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
