import { createFlowApp, type OrchestrationHost } from "@aura/orchestration";
import { validateMessages } from "@aura/protocol";
import type { ChatEvent } from "@aura/protocol/types";
import type { TripoPort } from "@aura/tripo";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { createCodexAuthApp } from "./codex-auth-routes.ts";
import {
  closeHonoServer,
  formatHttpUrl,
  localOriginPolicy,
  startHonoServer,
} from "./http-server.ts";
import type {
  ApiServerHandle,
  AuraPluginSettingsPort,
  CodexAuthPort,
  DshRoute,
  DshSessionPort,
  RuntimeConfig,
} from "./types.ts";
import { createPluginSettingsApp } from "./plugin-settings-routes.ts";
import { createTripoApp } from "./tripo-routes.ts";
import { isRecord } from "./validation.ts";
import { createVeyaCreatorApp, VeyaCreatorService } from "./veya-creator-routes.ts";
import { isLoopbackRuntimeHost } from "./runtime-config.ts";

interface ApiServerOptions {
  config: RuntimeConfig;
  codexAuth: CodexAuthPort;
  dsh: DshSessionPort;
  tripo: TripoPort;
  flows?: OrchestrationHost;
  pluginSettings?: AuraPluginSettingsPort;
  pluginSettingsAccessible?: boolean;
}

interface ApiLifecycle {
  shuttingDown: boolean;
  admittedRequests: number;
}

function registerChatRoute(
  app: Hono,
  path: string,
  route: () => DshRoute,
  dsh: DshSessionPort,
  lifecycle: ApiLifecycle,
) {
  app.post(
    path,
    bodyLimit({
      maxSize: 256 * 1_024,
      onError: (context) => context.text("无效的对话请求。", 413),
    }),
    async (context) => {
      if (lifecycle.shuttingDown || lifecycle.admittedRequests >= 2)
        return context.text("服务忙，请稍后再试。", 503);

      try {
        const body = (await context.req.json()) as unknown;
        if (!isRecord(body)) throw new Error("Invalid chat request.");
        const messages = body.messages;
        if (
          !validateMessages(messages) ||
          typeof body.sessionId !== "string" ||
          body.sessionId.length < 1 ||
          body.sessionId.length > 200
        )
          throw new Error("Invalid chat request.");

        lifecycle.admittedRequests++;
        context.header("Content-Type", "application/x-ndjson; charset=utf-8");
        context.header("Cache-Control", "no-cache");
        return stream(context, async (output) => {
          const disconnected = new AbortController();
          output.onAbort(() =>
            disconnected.abort(new Error("客户端连接已关闭。")),
          );
          let pendingWrite = Promise.resolve();
          const emit = (event: ChatEvent) => {
            if (output.aborted) return;
            pendingWrite = pendingWrite
              .then(async () => {
                await output.writeln(JSON.stringify(event));
              })
              .catch(() => undefined);
          };
          try {
            await dsh.stream(messages, emit, route(), disconnected.signal);
            await pendingWrite;
          } catch {
            emit({
              type: "error",
              message: "DSH 请求暂时不可用，请检查服务终端和登录状态后重试。",
            });
            await pendingWrite;
          } finally {
            lifecycle.admittedRequests--;
          }
        });
      } catch {
        return context.text("无效的对话请求。", 400);
      }
    },
  );
}

/** Builds the complete Hono API without opening a network listener. */
export function createApiApp({
  codexAuth,
  dsh,
  tripo,
  flows,
  pluginSettings,
  pluginSettingsAccessible = true,
  creator,
  lifecycle = { shuttingDown: false, admittedRequests: 0 },
}: Omit<ApiServerOptions, "config" | "tripo"> & {
  tripo?: TripoPort;
  lifecycle?: ApiLifecycle;
  creator?: VeyaCreatorService;
}) {
  const app = new Hono();
  app.use("*", localOriginPolicy);

  app.get("/health", (context) =>
    context.json({
      service: "aura-runtime",
      modes: ["dsh-demo", "codex-subscription"],
      keyRequired: false,
      integrations: { tripo: tripo?.configured ?? false },
    }),
  );
  app.route("/auth/codex", createCodexAuthApp(codexAuth));
  if (tripo) app.route("/tripo", createTripoApp(tripo));
  if (flows) app.route("/flows", createFlowApp(flows));
  if (creator) app.route("/veya/creator/v1", createVeyaCreatorApp(creator));
  if (pluginSettings)
    app.route(
      "/plugins/config",
      createPluginSettingsApp(pluginSettings, pluginSettingsAccessible),
    );

  registerChatRoute(
    app,
    "/chat",
    () => ({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "off",
      maxTokens: 2_048,
      mode: "demo",
    }),
    dsh,
    lifecycle,
  );
  registerChatRoute(
    app,
    "/chat/codex",
    () => ({
      provider: "openai-codex",
      model: codexAuth.modelId,
      reasoningEffort: "medium",
      maxTokens: 4_096,
      mode: "codex-subscription",
    }),
    dsh,
    lifecycle,
  );

  app.notFound((context) => context.body(null, 404));
  app.onError(
    () =>
      new Response(JSON.stringify({ message: "Aura runtime 请求处理失败。" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      }),
  );
  return app;
}

/** Starts the local Aura HTTP boundary over injected runtime services. */
export async function startApiServer({
  config,
  codexAuth,
  dsh,
  tripo,
  flows,
  pluginSettings,
  pluginSettingsAccessible,
}: ApiServerOptions): Promise<ApiServerHandle> {
  const lifecycle: ApiLifecycle = {
    shuttingDown: false,
    admittedRequests: 0,
  };
  const creator = flows && isLoopbackRuntimeHost(config.host)
    ? new VeyaCreatorService(config.root, flows) : undefined;
  if (creator) await creator.initialize();
  const app = createApiApp({
    codexAuth,
    dsh,
    tripo,
    flows,
    creator,
    pluginSettings,
    pluginSettingsAccessible,
    lifecycle,
  });
  const { server, port } = await startHonoServer(app, config.host, config.port);
  const sessionPath = creator ? join(creator.directory, "session.json") : undefined;
  try {
    if (creator && sessionPath) {
      const temporary = `${sessionPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ protocol: "aura-veya-creator/1",
          base_url: `${formatHttpUrl(config.host, port)}/veya/creator/v1/`,
          token: creator.bootstrapToken }), { mode: 0o600, flag: "wx" });
        await rename(temporary, sessionPath);
      } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    }
  } catch (error) { await closeHonoServer(server); throw error; }

  return {
    url: formatHttpUrl(config.host, port),
    async close() {
      if (lifecycle.shuttingDown) return;
      lifecycle.shuttingDown = true;
      await closeHonoServer(server);
      if (creator && sessionPath) {
        try {
          const current = JSON.parse(await readFile(sessionPath, "utf8")) as { token?: string };
          if (current.token === creator.bootstrapToken) await unlink(sessionPath);
        } catch { /* A newer session may already own this path. */ }
      }
    },
  };
}
