import assert from "node:assert/strict";
import test from "node:test";
import { createApiApp } from "../src/api-server.ts";
import { TripoService, type TripoPort } from "@aura/tripo";
import { FlowError } from "@aura/orchestration";
import type {
  AuraPluginSettingsPort,
  CodexAuthPort,
  ChatPort,
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

const chat: ChatPort = {
  async chatModels(mode) {
    return {
      mode,
      defaultModel: "gpt-test",
      models: [
        {
          id: "gpt-test",
          name: "Test model",
          defaultReasoningEffort: "xhigh",
          reasoningEfforts: [{ id: "xhigh", name: "Extra high" }],
        },
      ],
    };
  },
  async chat(turn, emit) {
    emit({ type: "delta", text: "hello" });
    if (turn.messages.at(-1)?.text === "配音")
      emit({
        type: "workflow",
        flowId: "tts",
        title: "语音合成",
        runId: "run-1",
        inputPreview: "{}",
      });
    return { model: turn.model ?? "deepseek-v4-flash" };
  },
};

test("chat model catalog and request overrides are scoped to chat and bounded", async () => {
  const turns: Array<Parameters<ChatPort["chat"]>[0]> = [];
  const app = createApiApp({
    codexAuth,
    chat: {
      ...chat,
      async chat(turn, emit) {
        turns.push(turn);
        if (turn.model === "unknown")
          throw new FlowError("对话模型不可用（UNKNOWN_MODEL）", 422);
        return chat.chat(turn, emit, new AbortController().signal);
      },
    },
  });
  const catalog = await app.request("/chat/models?mode=codex");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    await catalog.json(),
    await chat.chatModels("codex", new AbortController().signal),
  );
  assert.equal((await app.request("/chat/models?mode=other")).status, 400);
  const send = (modelConfig?: unknown) =>
    app.request("/chat/codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "chat-1",
        messages: [{ role: "user", text: "hello" }],
        ...(modelConfig === undefined ? {} : { modelConfig }),
      }),
    });
  const selected = await send({
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
  });
  assert.equal(selected.status, 200);
  await selected.text();
  await (await send()).text();
  assert.equal(turns[0]!.model, "gpt-6.1-sol");
  assert.equal(turns[0]!.reasoningEffort, "high");
  assert.equal(turns[1]!.model, codexAuth.modelId);
  assert.equal(turns[1]!.reasoningEffort, undefined);
  for (const invalid of [
    null,
    [],
    { model: "" },
    { model: "x".repeat(201) },
    { reasoningEffort: "x".repeat(81) },
    { provider: "arbitrary" },
    { apiKey: "secret" },
    { model: "m", baseURL: "https://example.com" },
  ])
    assert.equal((await send(invalid)).status, 400);
  assert.equal(
    turns.length,
    2,
    "invalid configuration never reaches the chat host",
  );
  const unavailable = await send({ model: "unknown" });
  assert.match(await unavailable.text(), /UNKNOWN_MODEL/);
  const noHost = createApiApp({ codexAuth });
  assert.equal((await noHost.request("/chat/models")).status, 503);
});

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
        id: "veya",
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
  const app = createApiApp({ codexAuth, chat, pluginSettings });
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
    chat,
    pluginSettings,
    pluginSettingsAccessible: false,
  });
  assert.equal((await lan.request("/plugins/config")).status, 403);
});

test("Hono API serves health, enforces origin policy and streams NDJSON", async () => {
  const app = createApiApp({ codexAuth, chat });

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

  const codex = await app.request("/chat/codex", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost:4311" },
    body: JSON.stringify({
      sessionId: "session-2",
      messages: [{ role: "user", text: "配音" }],
    }),
  });
  const codexEvents = (await codex.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    codexEvents.map((event) => event.type),
    ["delta", "workflow", "done"],
  );
  assert.equal(codexEvents[1]?.runId, "run-1");
  assert.equal(codexEvents[2]?.mode, "codex-subscription");
  assert.equal(codexEvents[2]?.model, codexAuth.modelId);
});

test("Hono API exposes validated asynchronous Tripo tasks", async () => {
  const app = createApiApp({ codexAuth, chat, tripo });

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
    chat,
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

test("coding turns accept uploaded image IDs and reject invalid ones", async () => {
  const turns: Array<{ prompt: string; images?: string[] }> = [];
  const app = createApiApp({
    codexAuth,
    chat: {
      ...chat,
      async coding(turn) {
        turns.push(turn);
        return { model: "gpt-test" };
      },
    },
  });
  const id = "a".repeat(64);
  const send = (body: Record<string, unknown>) =>
    app.request("/coding/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "coding-1",
        projectId: "project-1",
        mode: "codex",
        ...body,
      }),
    });
  const withImage = await send({ prompt: "look", images: [id] });
  assert.equal(withImage.status, 200);
  await withImage.text();
  const imageOnly = await send({ prompt: "", images: [id] });
  assert.equal(imageOnly.status, 200);
  await imageOnly.text();
  const textOnly = await send({ prompt: "hello" });
  await textOnly.text();
  assert.deepEqual(turns[0]!.images, [id]);
  assert.equal(turns[1]!.prompt, "");
  assert.deepEqual(turns[1]!.images, [id]);
  assert.equal("images" in turns[2]!, false);
  for (const invalid of [
    { prompt: "", images: [] },
    { prompt: "  " },
    { prompt: "x", images: ["../secret.png"] },
    { prompt: "x", images: "a".repeat(64) },
    { prompt: "x", images: Array(5).fill(id) },
  ])
    assert.equal((await send(invalid)).status, 400);
  assert.equal(turns.length, 3, "invalid requests never reach the host");
});
