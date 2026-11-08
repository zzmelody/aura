import assert from "node:assert/strict";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { FlowCatalog } from "@aura/protocol/types";
import { localMediaFixture } from "./local-media-fixture.ts";

test(
  "the built local media plugin owns its catalog and conversation tools",
  {
    skip:
      !process.env.AURA_TEST_LOCAL_MEDIA_PLUGIN ||
      !process.env.AURA_TEST_LOCAL_MEDIA_MODELS
        ? "Requires a built local-media plugin and model directory setting"
        : false,
    timeout: 60_000,
  },
  async (t) => {
    const requests: unknown[] = [];
    const app = new Hono();
    app.post("/v1/chat/completions", async (context) => {
      requests.push(await context.req.json());
      return streamSSE(context, async (stream) => {
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "fixture" },
                finish_reason: "stop",
              },
            ],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
      });
    });
    let model!: ServerType;
    const port = await new Promise<number>((resolve) => {
      model = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(port),
      );
    });
    t.after(() => {
      model.close();
    });
    const { host, close } = await localMediaFixture(
      `http://127.0.0.1:${port}/v1`,
    );
    t.after(close);
    const catalog = await host.request<FlowCatalog>("catalog");
    assert.deepEqual(catalog.flows.map(({ id }) => id).sort(), [
      "local-media/image",
      "local-media/tts",
    ]);
    const imageSchema = JSON.stringify(
      catalog.flows.find(({ id }) => id === "local-media/image")?.inputSchema ??
        null,
    );
    assert.match(imageSchema, /"referenceImages"/u);
    assert.match(imageSchema, /"maxItems":4/u);
    assert.ok(
      catalog.actions?.some(
        ({ id, available }) => id === "local-media/local-tts" && available,
      ),
    );
    const status = await host.invokeAction("local-media/local-ai-service", {
      input: { service: "qwen3-tts", operation: "status" },
      mode: "demo",
    });
    assert.equal(status.status, "completed");
    const chat = () =>
      host.chat(
        { mode: "demo", messages: [{ role: "user", text: "fixture" }] },
        () => {},
        AbortSignal.timeout(20_000),
      );
    await chat();
    assert.match(JSON.stringify(requests.at(-1)), /"name":"aura_tts"/u);
    assert.match(JSON.stringify(requests.at(-1)), /"name":"aura_image"/u);
    assert.match(JSON.stringify(requests.at(-1)), /"referenceImages"/u);
    await host.configureContributions({
      flowRoots: [],
      actionRoots: [],
      backendRoots: [],
      plugins: [],
    });
    assert.deepEqual((await host.request<FlowCatalog>("catalog")).flows, []);
    await chat();
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)),
      /"name":"aura_(tts|image)"/u,
    );
  },
);
