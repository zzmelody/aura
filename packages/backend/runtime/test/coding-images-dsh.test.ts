import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import sharp from "sharp";
import { FlowError, OrchestrationHost } from "../src/dsh/host.ts";

test(
  "coding rejects images on a text-only model with an actionable error and accepts a later text turn",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-images-"));
    const resources: { host?: OrchestrationHost; server?: ServerType } = {};
    t.after(async () => {
      await resources.host?.close();
      const currentServer = resources.server;
      if (currentServer) {
        if ("closeAllConnections" in currentServer)
          currentServer.closeAllConnections();
        await new Promise<void>((resolve) =>
          currentServer.close(() => resolve()),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    const flowRoot = join(root, "flows");
    await mkdir(flowRoot);
    let calls = 0;
    const app = new Hono().post("/v1/chat/completions", (context) => {
      calls++;
      // Synthetic local model; this test never reaches an external provider.
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "fixture reply" },
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
      const server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(port),
      );
      resources.server = server;
      server.once("error", reject);
    });
    const host = new OrchestrationHost({
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    });
    resources.host = host;
    const signal = AbortSignal.timeout(60_000);
    const image = await host.uploadImage(
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer(),
      signal,
    );
    const request = {
      sessionId: "coding-image-admission",
      prompt: "Describe the attachment",
      mode: "demo" as const,
      model: "deepseek-v4-flash",
      reasoningEffort: "off",
    };
    await assert.rejects(
      host.coding({ ...request, images: [image.artifactId] }, () => {}, signal),
      (error: unknown) => {
        assert.ok(error instanceof FlowError);
        assert.equal(error.status, 422);
        assert.match(error.message, /不支持图片输入/u);
        assert.match(error.message, /移除附件/u);
        return true;
      },
    );
    assert.equal(calls, 0, "rejected images never reach the model");
    assert.deepEqual(
      (await host.codingHistory(request.sessionId)).turns,
      [],
      "a rejected prompt never becomes a model turn",
    );
    const result = await host.coding(request, () => {}, signal);
    assert.equal(result.model, request.model);
    assert.equal(calls, 1, "the user can explicitly submit a text-only turn");
  },
);
