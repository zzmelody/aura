import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/index.ts";
import { PERSONAL_ASSISTANT_SESSION_ID } from "@aura/protocol/conversations";

test(
  "the one assistant resumes its DSH history after a host restart",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-personal-assistant-"));
    let host!: OrchestrationHost;
    let server!: ServerType;
    t.after(async () => {
      await host?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const flowRoot = join(root, "flows");
    await mkdir(flowRoot);
    const requests: unknown[] = [];
    const app = new Hono();
    app.post("/v1/chat/completions", async (context) => {
      requests.push(await context.req.json());
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "assistant fixture reply" },
                finish_reason: null,
              },
            ],
          }),
        });
        await output.writeSSE({
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await output.writeSSE({ data: "[DONE]" });
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(port),
      );
      server.once("error", reject);
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      defaultWorkspace: join(root, "assistant-workspace"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    host = new OrchestrationHost(options);
    assert.equal(await host.personalAssistant(), null);
    assert.equal(requests.length, 0);
    const opened = await Promise.all(
      Array.from({ length: 5 }, () => host.personalAssistant(true)),
    );
    const assistant = opened[0]!;
    assert.ok(assistant);
    assert.ok(
      opened.every(
        (info) => info?.conversation.id === PERSONAL_ASSISTANT_SESSION_ID,
      ),
    );
    assert.equal(
      requests.length,
      0,
      "Opening the assistant never calls a model",
    );
    const turn = (prompt: string) =>
      host.coding(
        {
          sessionId: PERSONAL_ASSISTANT_SESSION_ID,
          projectId: assistant.project.id,
          prompt,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        () => {},
        AbortSignal.timeout(30_000),
      );
    await turn("REMEMBER_PERSONAL_ASSISTANT_CONTEXT");
    await host.close();
    host = new OrchestrationHost(options);
    assert.equal(
      (await host.personalAssistant())?.conversation.id,
      PERSONAL_ASSISTANT_SESSION_ID,
    );
    assert.deepEqual(
      (await host.codingHistory(PERSONAL_ASSISTANT_SESSION_ID)).turns.map(
        (item) => item.prompt,
      ),
      ["REMEMBER_PERSONAL_ASSISTANT_CONTEXT"],
    );
    await turn("CONTINUE_SAME_ASSISTANT");
    const metadata = await host.conversations(assistant.project.id, false);
    assert.equal(
      metadata.find((item) => item.id === PERSONAL_ASSISTANT_SESSION_ID)
        ?.lastTurnStatus,
      undefined,
    );
    assert.ok(
      JSON.stringify(requests.at(-1)).includes(
        "REMEMBER_PERSONAL_ASSISTANT_CONTEXT",
      ),
    );
    assert.equal(
      (await host.conversations(assistant.project.id)).filter(
        (item) => item.id === PERSONAL_ASSISTANT_SESSION_ID,
      ).length,
      1,
    );
    await assert.rejects(
      host.request("coding/conversation/archive", {
        sessionId: PERSONAL_ASSISTANT_SESSION_ID,
        archived: true,
      }),
      /不能归档/u,
    );
  },
);
