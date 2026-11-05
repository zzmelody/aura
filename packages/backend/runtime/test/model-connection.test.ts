import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { CodexSubscriptionAuth } from "@aura/dsh-auth";
import { AiServices } from "../src/ai-services.ts";
import { createAiServicesApp } from "../src/ai-services-routes.ts";
import { resolveRuntimeConfig } from "../src/runtime-config.ts";

test("model discovery and a real inference have separate results; denied/empty responses cannot pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-model-probe-"));
  const config = resolveRuntimeConfig({ root });
  const auth = await CodexSubscriptionAuth.create({
    credentialPath: config.credentialPath,
  });
  const services = new AiServices(config, auth);
  const api = createAiServicesApp(services, true, "fixture-bootstrap");
  const call = async (path: string) => {
    const response = await api.request(path, {
      method: "POST",
      headers: { authorization: "Bearer fixture-bootstrap" },
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<
      Awaited<ReturnType<AiServices["settings"]>>
    >;
  };
  assert.equal(
    (
      await api.request("/models", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  let mode: "ok" | "denied" | "empty" = "ok";
  let inference = 0;
  const app = new Hono();
  app.get("/v1/models", (c) =>
    c.json({ data: [{ id: "fixture-chat" }, { id: "fixture-other" }] }),
  );
  app.post("/v1/chat/completions", async (c) => {
    inference++;
    assert.equal(c.req.header("authorization"), "Bearer fixture-secret");
    const body = await c.req.json();
    assert.equal(body.model, "fixture-chat");
    assert.ok(
      body.messages.some(
        (m: { content?: string }) => m.content === "Reply with only OK.",
      ),
    );
    if (mode === "denied")
      return c.json(
        { error: { message: "fixture-secret private failure" } },
        401,
      );
    const delta = mode === "empty" ? {} : { content: "OK" };
    const chunk = {
      id: "fixture-response",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-chat",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    const finish = {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await auth.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const settings = {
    mode: "custom",
    model: "fixture-chat",
    reasoningEffort: "off",
    custom: {
      name: "Fixture",
      api: "openai-completions",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      images: false,
      contextWindow: 65536,
    },
  };
  await services.saveModel({ ...settings, key: "fixture-secret" });
  const catalog = await call("/models");
  assert.deepEqual(catalog.catalog.custom, ["fixture-chat", "fixture-other"]);
  const savedAgain = await services.saveModel(settings);
  assert.deepEqual(
    savedAgain.catalog.custom,
    catalog.catalog.custom,
    "saving a selected model retains the catalog for the same address and protocol",
  );
  assert.equal(
    inference,
    0,
    "listing models is never presented as a successful model request",
  );
  const success = await call("/check/model");
  assert.equal(inference, 1);
  assert.match(success.checks.model, /测试成功.*fixture-chat.*回复：OK/u);
  assert.equal(success.checkRuns.model, 1);
  mode = "denied";
  const failed = await call("/check/model");
  assert.match(failed.checks.model, /测试失败.*认证失败/u);
  assert.ok(!JSON.stringify(failed).includes("fixture-secret"));
  assert.equal(failed.checkRuns.model, 2);
  mode = "empty";
  const empty = await call("/check/model");
  assert.match(empty.checks.model, /测试失败.*没有返回有效文本/u);
});
