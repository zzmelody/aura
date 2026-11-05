import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAuraPlugins } from "@aura/plugin-manager";
import {
  GeneratedArtifacts,
  PluginHttpRegistry,
} from "@aura/orchestration/host";
import { createApiApp } from "../src/api-server.ts";
import { createCodingApp } from "../src/coding-routes.ts";
import type { OrchestrationHost } from "../src/dsh/host.ts";
import { reservedPluginHttpMounts } from "../src/plugin-http-mounts.ts";
import { FlowError } from "@aura/orchestration";
import type { CodingSteerModelConfig } from "@aura/protocol/types";
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

test("plugin HTTP serves top-level and Flow mounts with origin and route ownership checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    join(root, "aura.plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "example.http",
      name: "HTTP fixture",
      version: "0.1.0",
      engines: { aura: "*", pluginSdk: "*" },
      contributes: {
        backend: "./backend.js",
        http: { entry: "./http.js", mounts: ["/tripo", "/flows/example"] },
      },
    }),
  );
  await writeFile(join(root, "backend.js"), "export default {};\n");
  await writeFile(
    join(root, "http.js"),
    `export default () => ({
      async fetch(request) {
        return Response.json({ path: new URL(request.url).pathname,
          bytes: (await request.arrayBuffer()).byteLength }, { status: 201 });
      },
    });`,
  );
  const plugins = await loadAuraPlugins({
    configPath: join(root, "plugins.json"),
    defaultPluginsDirectory: root,
    auraVersion: "0.1.0",
    pluginSdkVersion: "2.0.0",
  });
  const backend = plugins.backendRoots[0];
  assert.ok(backend?.http, plugins.plugins[0]?.error);
  const contribution = { ...backend, root: backend.path, http: backend.http };
  const registry = new PluginHttpRegistry(
    {
      request: async () => {
        throw new Error("unexpected RPC");
      },
      artifacts: new GeneratedArtifacts(join(root, "assets")),
      artifactContent: async () => {
        throw new Error("unexpected asset request");
      },
    },
    reservedPluginHttpMounts,
  );
  t.after(() => registry.close());
  await registry.replace([contribution]);
  const flows = {
    pluginHttp: (request: Request) => registry.fetch(request),
  } as OrchestrationHost;
  const app = createApiApp({ codexAuth, flows });
  for (const path of ["/tripo", "/tripo/assets", "/flows/example/assets"]) {
    const response = await app.request(path, {
      method: "POST",
      body: new Uint8Array(300 * 1024),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { path, bytes: 300 * 1024 });
  }
  assert.equal((await app.request("/tripo-extra")).status, 404);
  assert.equal(
    (
      await app.request("/tripo/assets", {
        headers: { Host: "localhost", Origin: "https://foreign.example" },
      })
    ).status,
    403,
  );

  await assert.rejects(
    registry.replace([
      {
        ...contribution,
        http: { ...contribution.http, mounts: ["/health"] },
      },
    ]),
    { status: 409 },
  );
  await assert.rejects(registry.replace([contribution, contribution]), {
    status: 409,
  });
  assert.equal((await app.request("/tripo")).status, 201);
  await registry.replace([]);
  assert.equal((await app.request("/tripo")).status, 404);
});

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

const pluginState = {
  configPath: "F:\\aura\\.aura\\plugins.json",
  plugins: [
    {
      path: "F:/creative/aura-plugin",
      enabled: true,
      trust: "local" as const,
      builtin: false,
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
  const app = createApiApp({
    codexAuth,
    chat,
    readiness: {
      async health() {
        return { status: "ready" };
      },
    },
  });

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

test("health reports DSH startup, failure, recovery and shutdown without leaking errors", async () => {
  let status: "starting" | "ready" | "unavailable" | "stopped" = "starting";
  let fail = false;
  const lifecycle = { shuttingDown: false, admittedRequests: 0 };
  const app = createApiApp({
    codexAuth,
    lifecycle,
    readiness: {
      async health() {
        if (fail) throw new Error("Bearer private-provider-token");
        return { status };
      },
    },
  });
  for (const state of [
    "starting",
    "unavailable",
    "ready",
    "stopped",
  ] as const) {
    status = state;
    const response = await app.request("/health");
    assert.equal(response.status, state === "ready" ? 200 : 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.service, "aura-runtime");
    assert.deepEqual(body.dsh, { status: state });
  }
  fail = true;
  const failed = await app.request("/health");
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private-provider-token/);
  fail = false;
  status = "ready";
  lifecycle.shuttingDown = true;
  assert.equal((await app.request("/health")).status, 503);
  const noHost = createApiApp({ codexAuth });
  assert.equal((await noHost.request("/health")).status, 503);
});

test("the stop route forwards the conversation id and reports the result", async () => {
  const stopped: string[] = [];
  const flows = {
    async stopCoding(sessionId: string) {
      stopped.push(sessionId);
      return { stopped: sessionId === "coding-1" };
    },
  } as unknown as NonNullable<Parameters<typeof createApiApp>[0]["flows"]>;
  const app = createCodingApp(flows);
  const stop = (id: string) =>
    app.request(`/sessions/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    });
  const live = await stop("coding-1");
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { stopped: true });
  assert.deepEqual(await (await stop("coding-idle")).json(), {
    stopped: false,
  });
  assert.deepEqual(stopped, ["coding-1", "coding-idle"]);
});

test("the steer route validates its content and reports admission", async () => {
  const sent: Array<{
    sessionId: string;
    prompt: string;
    images?: string[];
    modelConfig?: CodingSteerModelConfig;
    requestId?: string;
  }> = [];
  const flows = {
    async steerCoding(
      sessionId: string,
      prompt: string,
      images?: string[],
      modelConfig?: CodingSteerModelConfig,
      requestId?: string,
    ) {
      sent.push({
        sessionId,
        prompt,
        ...(images ? { images } : {}),
        ...(modelConfig ? { modelConfig } : {}),
        ...(requestId ? { requestId } : {}),
      });
      return { steered: sessionId === "coding-1" };
    },
  } as unknown as NonNullable<Parameters<typeof createApiApp>[0]["flows"]>;
  const app = createCodingApp(flows);
  const id = "a".repeat(64);
  const steer = (session: string, body: Record<string, unknown>) =>
    app.request(`/sessions/${encodeURIComponent(session)}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const requestId = "00000000-0000-4000-8000-000000000001";
  const live = await steer("coding-1", { prompt: "改用 map", requestId });
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { steered: true });
  // A turn that ended first is reported, not treated as an error.
  assert.deepEqual(await (await steer("coding-idle", { prompt: "x" })).json(), {
    steered: false,
  });
  // An image-only message is allowed, as it is for a turn.
  const imageOnly = await steer("coding-1", { prompt: "", images: [id] });
  assert.equal(imageOnly.status, 200);
  assert.deepEqual(sent.slice(), [
    { sessionId: "coding-1", prompt: "改用 map", requestId },
    { sessionId: "coding-idle", prompt: "x" },
    { sessionId: "coding-1", prompt: "", images: [id] },
  ]);

  const modelConfig = {
    mode: "codex",
    selection: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  };
  assert.equal(
    (await steer("coding-1", { prompt: "换模型继续", modelConfig })).status,
    200,
  );
  assert.deepEqual(sent.at(-1)?.modelConfig, modelConfig);

  for (const invalid of [
    { prompt: "x", requestId: "bad" },
    { prompt: "x", modelConfig: null },
    {
      prompt: "x",
      modelConfig: { mode: "codex", selection: {}, provider: "forbidden" },
    },
    { prompt: "x", modelConfig: { mode: "invalid", selection: {} } },
    { prompt: "x", modelConfig: { mode: { toString: null }, selection: {} } },
    {
      prompt: "x",
      modelConfig: { mode: "codex", selection: { apiKey: "forbidden" } },
    },
    { prompt: "x", modelConfig: { mode: "codex", selection: { model: "" } } },
    { prompt: "x", modelConfig: { mode: "codex" } },
    {},
    { prompt: "" },
    { prompt: "  " },
    { prompt: "", images: [] },
    { prompt: 7 },
    { prompt: "x", images: ["../secret.png"] },
    { prompt: "x", images: "a".repeat(64) },
    { prompt: "x", images: Array(5).fill(id) },
  ])
    assert.equal(
      (await steer("coding-1", invalid)).status,
      400,
      `accepted ${JSON.stringify(invalid)}`,
    );
  assert.equal(sent.length, 4, "invalid requests never reach the host");
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

test("coding preserves safe image admission errors and hides unexpected failures", async () => {
  const message =
    "当前模型不支持图片输入，请更换支持图片的模型，或移除附件后重新发送。";
  let unsupported = true;
  const app = createApiApp({
    codexAuth,
    chat: {
      ...chat,
      async coding() {
        if (unsupported) throw new FlowError(message, 422);
        throw new Error("Bearer private-provider-token");
      },
    },
  });
  const send = () =>
    app.request("/coding/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "coding-image-error",
        prompt: "describe",
        mode: "codex",
        images: ["a".repeat(64)],
      }),
    });
  assert.deepEqual(JSON.parse(await (await send()).text()), {
    type: "error",
    message,
  });
  unsupported = false;
  const unexpected = await (await send()).text();
  assert.doesNotMatch(unexpected, /private-provider-token/u);
  assert.match(unexpected, /编码请求暂时不可用/u);
});

test("coding forwards only supported collaboration intents", async () => {
  const intents: unknown[] = [];
  const app = createApiApp({
    codexAuth,
    chat: {
      ...chat,
      async coding(turn) {
        intents.push(turn.intent);
        return { model: "fixture" };
      },
    },
  });
  const send = (body: Record<string, unknown>) =>
    app.request("/coding/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "fixture",
        prompt: "Work on this",
        mode: "demo",
        ...body,
      }),
    });
  assert.equal((await send({ intent: "unsupported" })).status, 400);
  assert.equal(
    (await send({ intent: "goal", images: ["a".repeat(64)] })).status,
    400,
  );
  for (const intent of ["plan", "execute", "goal", "resume-goal"])
    assert.match(await (await send({ intent })).text(), /"type":"done"/u);
  assert.deepEqual(intents, ["plan", "execute", "goal", "resume-goal"]);
});
