import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexSubscriptionAuth } from "@aura/dsh-auth";
import { AiServices } from "../src/ai-services.ts";
import { createAiServicesApp } from "../src/ai-services-routes.ts";
import { resolveRuntimeConfig } from "../src/runtime-config.ts";

test("AI routes require the native loopback capability and never return submitted credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-ai-routes-"));
  const config = resolveRuntimeConfig({ root });
  const auth = await CodexSubscriptionAuth.create({
    credentialPath: config.credentialPath,
  });
  let busy = false;
  const services = new AiServices(config, auth, async () => busy);
  const app = createAiServicesApp(services, true, "fixture-bootstrap");
  t.after(async () => {
    await auth.close();
    await rm(root, { recursive: true, force: true });
  });
  // Loopback workbench may omit the capability; a wrong one is always refused.
  assert.equal((await app.request("/")).status, 200);
  assert.equal(
    (await app.request("/", { headers: { authorization: "Bearer wrong" } }))
      .status,
    401,
  );
  assert.equal(
    (
      await createAiServicesApp(services, false, "fixture-bootstrap").request(
        "/",
        { headers: { authorization: "Bearer fixture-bootstrap" } },
      )
    ).status,
    403,
  );
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-bootstrap",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const response = await post("/model", {
    mode: "custom",
    model: "fixture-model",
    reasoningEffort: "off",
    key: "private-fixture-key",
    custom: {
      name: "Local",
      api: "openai-responses",
      baseURL: "https://fixture.example/v1",
      images: true,
      contextWindow: 262144,
    },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("private-fixture-key"));
  assert.equal(JSON.parse(body).model.configured, true);
  assert.equal(response.headers.get("cache-control"), "no-store");
  busy = true;
  assert.equal((await post("/codex/logout", {})).status, 400);
  assert.equal(
    (
      await post("/model", {
        mode: "custom",
        model: "fixture-model",
        reasoningEffort: "off",
        clearKey: true,
        custom: {
          name: "Local",
          api: "openai-responses",
          baseURL: "https://fixture.example/v1",
          images: true,
          contextWindow: 262144,
        },
      })
    ).status,
    400,
  );
  busy = false;
  assert.equal(
    (
      await post("/model", {
        mode: "codex",
        model: "invalid-model",
        reasoningEffort: "high",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post("/model", {
        mode: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
      })
    ).status,
    200,
  );
});
