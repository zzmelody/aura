import assert from "node:assert/strict";
import test from "node:test";
import { createApiApp } from "../src/api-server.ts";
import { TripoService, type TripoPort } from "@aura/tripo";
import type {
  AuraPluginSettingsPort,
  CodexAuthPort,
  DshSessionPort,
} from "../src/types.ts";

const codexAuth: CodexAuthPort = {
  modelId: "gpt-test",
  async status() {
    return { state: "signed_out", model: this.modelId };
  },
  async startLogin(method) {
    return { state: "pending", method, model: this.modelId };
  },
  submitLoginInput() {
    return { state: "signed_out", model: this.modelId };
  },
  async cancelLogin() {
    return { state: "signed_out", model: this.modelId };
  },
};

const dsh: DshSessionPort = {
  async stream(_messages, emit, route) {
    emit({ type: "delta", text: "hello" });
    emit(
      route.mode === "codex-subscription"
        ? {
            type: "done",
            engine: "deepseek-harness",
            mode: route.mode,
            model: route.model,
          }
        : { type: "done", engine: "deepseek-harness", mode: route.mode },
    );
  },
};

const tripo: TripoPort = {
  configured: true,
  status() {
    return {
      configured: true,
      region: "global",
      apiVersion: "v3",
      features: ["text-to-model", "image-to-model", "task-status"],
    };
  },
  async textToModel(input) {
    assert.equal(input.prompt, "a low-poly fox");
    return "tripo-task-1";
  },
  async imageToModel() {
    return "tripo-task-2";
  },
  async getTask(taskId) {
    return {
      taskId,
      type: "text_to_model",
      status: "running",
      progress: 42,
    };
  },
};

const pluginState = {
  configPath: "F:\\aura\\.aura\\plugins.json",
  plugins: [
    {
      path: "F:/creative/aura-plugin",
      enabled: true,
      trust: "local" as const,
      status: {
        id: "zzmelody.veya",
        name: "Veya Creative",
        version: "0.1.1",
        enabled: true,
        available: true,
      },
    },
  ],
  active: [],
  applyRequired: true,
};

test("Hono API restricts and delegates trusted plugin configuration", async () => {
  let updated: unknown;
  const pluginSettings: AuraPluginSettingsPort = {
    async settings() {
      return pluginState;
    },
    async updateSettings(source) {
      updated = source;
      return pluginState;
    },
  };
  const app = createApiApp({ codexAuth, dsh, pluginSettings });
  const status = await app.request("/plugins/config");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), pluginState);

  const update = {
    plugins: [{ path: "F:/creative/aura-plugin", enabled: true }],
  };
  const saved = await app.request("/plugins/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(updated, update);
  assert.equal(
    (
      await app.request("/plugins/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    ).status,
    400,
  );

  const lan = createApiApp({
    codexAuth,
    dsh,
    pluginSettings,
    pluginSettingsAccessible: false,
  });
  assert.equal((await lan.request("/plugins/config")).status, 403);
});

test("Hono API serves health, enforces origin policy and streams NDJSON", async () => {
  const app = createApiApp({ codexAuth, dsh });

  const health = await app.request("/health");
  assert.equal(health.status, 200);
  assert.equal(
    ((await health.json()) as { service: string }).service,
    "aura-runtime",
  );

  const rejected = await app.request("/health", {
    headers: { Host: "localhost:4311", Origin: "https://example.com" },
  });
  assert.equal(rejected.status, 403);

  const capacitor = await app.request("/health", {
    headers: { Host: "192.168.1.8:4311", Origin: "https://localhost" },
  });
  assert.equal(capacitor.status, 200);
  assert.equal(
    capacitor.headers.get("access-control-allow-origin"),
    "https://localhost",
  );

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:4311",
      Origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({
      sessionId: "session-1",
      messages: [{ role: "user", text: "hello" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /x-ndjson/);
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  assert.deepEqual(
    events.map((event) => event.type),
    ["delta", "done"],
  );
});

test("Hono API exposes validated asynchronous Tripo tasks", async () => {
  const app = createApiApp({ codexAuth, dsh, tripo });

  const status = await app.request("/tripo/status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), tripo.status());

  const created = await app.request("/tripo/tasks/text-to-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "a low-poly fox", faceLimit: 3_000 }),
  });
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), { taskId: "tripo-task-1" });

  const task = await app.request("/tripo/tasks/tripo-task-1");
  assert.equal(task.status, 200);
  assert.deepEqual(await task.json(), {
    taskId: "tripo-task-1",
    type: "text_to_model",
    status: "running",
    progress: 42,
  });

  const invalid = await app.request("/tripo/tasks/image-to-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: { url: "http://127.0.0.1/private.png" } }),
  });
  assert.equal(invalid.status, 400);

  const unavailable = createApiApp({
    codexAuth,
    dsh,
    tripo: new TripoService("global"),
  });
  const notConfigured = await unavailable.request(
    "/tripo/tasks/text-to-model",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a low-poly fox" }),
    },
  );
  assert.equal(notConfigured.status, 503);
  assert.deepEqual(await notConfigured.json(), {
    code: "tripo_not_configured",
    message: "Tripo 尚未配置，请先在后端设置 API Key。",
  });
});
