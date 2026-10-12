import {
  createFlowApp,
  FlowError,
  type OrchestrationHost,
} from "@aura/orchestration";
import { validateMessages, validateChatModelSelection } from "@aura/protocol";
import type { ChatEvent } from "@aura/protocol/types";
import type { TripoPort } from "@aura/tripo";
import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { createCodexAuthApp } from "./codex-auth-routes.ts";
import { createCodingApp } from "./coding-routes.ts";
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
  ChatPort,
  ChatRoute,
  RuntimeConfig,
} from "./types.ts";
import { createPluginSettingsApp } from "./plugin-settings-routes.ts";
import { createTripoApp } from "./tripo-routes.ts";
import { isRecord } from "./validation.ts";
import { isLoopbackRuntimeHost } from "./runtime-config.ts";
import { createAiServicesApp } from "./ai-services-routes.ts";
import { createServiceApp, ServiceRuns } from "./service-routes.ts";
import type { AiServicesPort } from "./ai-services.ts";

interface ApiServerOptions {
  aiServices?: AiServicesPort;
  config: RuntimeConfig;
  codexAuth: CodexAuthPort;
  chat?: ChatPort;
  tripo: TripoPort;
  flows?: OrchestrationHost;
  pluginSettings?: AuraPluginSettingsPort;
  pluginSettingsAccessible?: boolean;
}

/** Atomically publishes a 0600 loopback descriptor that local clients read. */
async function publishDescriptor(path: string, value: object) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Removes a descriptor only while it still carries this process's token. */
async function removeDescriptor(path: string, token: string) {
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as {
      token?: string;
    };
    if (current.token === token) await unlink(path);
  } catch {
    /* A newer runtime may already own this path. */
  }
}

interface ApiLifecycle {
  shuttingDown: boolean;
  admittedRequests: number;
}

function registerChatRoute(
  app: Hono,
  path: string,
  route: () => ChatRoute,
  chat: ChatPort | undefined,
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
          body.sessionId.length > 200 ||
          (body.modelConfig !== undefined &&
            !validateChatModelSelection(body.modelConfig))
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
            if (!chat) throw new Error("Chat host is unavailable.");
            const target = route();
            const { model } = await chat.chat(
              { messages, ...target, ...(body.modelConfig ?? {}) },
              emit,
              disconnected.signal,
            );
            emit(
              target.mode === "demo"
                ? { type: "done", engine: "deepseek-harness", mode: "demo" }
                : {
                    type: "done",
                    engine: "deepseek-harness",
                    mode:
                      target.mode === "codex"
                        ? "codex-subscription"
                        : target.mode,
                    model,
                  },
            );
            await pendingWrite;
          } catch (error) {
            emit({
              type: "error",
              message:
                error instanceof FlowError && error.status === 422
                  ? error.message
                  : "DSH 请求暂时不可用，请检查服务终端和登录状态后重试。",
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
  aiServices,
  codexAuth,
  chat,
  tripo,
  flows,
  pluginSettings,
  pluginSettingsAccessible = true,
  services,
  lifecycle = { shuttingDown: false, admittedRequests: 0 },
}: Omit<ApiServerOptions, "config" | "tripo"> & {
  tripo?: TripoPort;
  lifecycle?: ApiLifecycle;
  services?: ServiceRuns;
}) {
  const app = new Hono();
  app.use("*", localOriginPolicy);

  app.get("/health", (context) =>
    context.json({
      service: "aura-runtime",
      modes: ["dsh-demo", "codex-subscription", "lumina", "custom"],
      keyRequired: false,
      integrations: { tripo: tripo?.configured ?? false },
    }),
  );
  app.route("/auth/codex", createCodexAuthApp(codexAuth));
  if (tripo) app.route("/tripo", createTripoApp(tripo));
  if (flows) app.route("/flows", createFlowApp(flows));
  // Coding projects ride on the same host; a runtime without it omits the set.
  if (flows) app.route("/coding", createCodingApp(flows));
  if (services) app.route("/services", createServiceApp(services));
  if (aiServices)
    app.route(
      "/ai/services",
      createAiServicesApp(
        aiServices,
        pluginSettingsAccessible,
        services?.token,
      ),
    );
  if (pluginSettings)
    app.route(
      "/plugins/config",
      createPluginSettingsApp(pluginSettings, pluginSettingsAccessible),
    );

  app.get("/chat/models", async (context) => {
    const mode = context.req.query("mode") ?? "codex";
    if (!["codex", "demo", "lumina", "custom"].includes(mode))
      return context.json({ message: "无效的对话模式。" }, 400);
    const host = chat ?? flows;
    if (!host || lifecycle.shuttingDown)
      return context.json({ message: "对话模型目录暂时不可用。" }, 503);
    try {
      context.header("Cache-Control", "no-store");
      return context.json(
        await host.chatModels(
          mode as ChatRoute["mode"],
          AbortSignal.any([
            context.req.raw.signal,
            AbortSignal.timeout(20_000),
          ]),
        ),
      );
    } catch {
      return context.json({ message: "无法读取 DSH 模型目录，请重试。" }, 503);
    }
  });

  registerChatRoute(
    app,
    "/chat",
    () => ({ mode: "demo" }),
    chat ?? flows,
    lifecycle,
  );
  registerChatRoute(
    app,
    "/chat/codex",
    () => ({ mode: "codex", model: codexAuth.modelId }),
    chat ?? flows,
    lifecycle,
  );
  // Gateway routes resolve their provider and default model from saved settings.
  registerChatRoute(
    app,
    "/chat/lumina",
    () => ({ mode: "lumina" }),
    chat ?? flows,
    lifecycle,
  );
  registerChatRoute(
    app,
    "/chat/custom",
    () => ({ mode: "custom" }),
    chat ?? flows,
    lifecycle,
  );

  app.post(
    "/coding/turn",
    bodyLimit({
      maxSize: 256 * 1_024,
      onError: (context) => context.text("无效的编码请求。", 413),
    }),
    async (context) => {
      if (lifecycle.shuttingDown)
        return context.text("服务忙，请稍后再试。", 503);
      const body = (await context.req.json().catch(() => undefined)) as
        Record<string, unknown> | undefined;
      if (
        !isRecord(body) ||
        typeof body.sessionId !== "string" ||
        typeof body.projectId !== "string" ||
        typeof body.prompt !== "string" ||
        !body.prompt.trim() ||
        body.prompt.length > 80_000 ||
        !["codex", "lumina", "custom", "demo"].includes(String(body.mode)) ||
        (body.modelConfig !== undefined &&
          !validateChatModelSelection(body.modelConfig))
      )
        return context.text("无效的编码请求。", 400);
      if (!chat && !flows) return context.text("编码服务不可用。", 503);
      const host = chat ?? flows;
      const coding = host?.coding?.bind(host);
      if (!coding) return context.text("编码服务不可用。", 503);

      const mode = body.mode as ChatRoute["mode"];
      const selection = body.modelConfig as
        { model?: string; reasoningEffort?: string } | undefined;
      context.header("Content-Type", "application/x-ndjson; charset=utf-8");
      context.header("Cache-Control", "no-cache");
      return stream(context, async (output) => {
        const disconnected = new AbortController();
        output.onAbort(() =>
          disconnected.abort(new Error("客户端连接已关闭。")),
        );
        let pendingWrite = Promise.resolve();
        const emit = (event: unknown) => {
          if (output.aborted) return;
          pendingWrite = pendingWrite
            .then(async () => {
              await output.writeln(JSON.stringify(event));
            })
            .catch(() => undefined);
        };
        try {
          const { model } = await coding(
            {
              sessionId: body.sessionId as string,
              projectId: body.projectId as string,
              prompt: body.prompt as string,
              mode,
              ...(selection?.model ? { model: selection.model } : {}),
              ...(selection?.reasoningEffort
                ? { reasoningEffort: selection.reasoningEffort }
                : {}),
            },
            emit,
            disconnected.signal,
          );
          emit({
            type: "done",
            engine: "deepseek-harness",
            mode: mode === "codex" ? "codex-subscription" : mode,
            model,
          });
          await pendingWrite;
        } catch (error) {
          emit({
            type: "error",
            message:
              // Validation failures (removed project, wrong project, missing
              // tools) are written for the user; anything else stays generic.
              error instanceof FlowError && error.status < 500
                ? error.message
                : "编码请求暂时不可用，请检查服务终端和登录状态后重试。",
          });
          await pendingWrite;
        }
      });
    },
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
  aiServices,
  config,
  codexAuth,
  tripo,
  flows,
  pluginSettings,
  pluginSettingsAccessible,
}: ApiServerOptions): Promise<ApiServerHandle> {
  const lifecycle: ApiLifecycle = {
    shuttingDown: false,
    admittedRequests: 0,
  };
  // Local service clients get one per-process token through .aura/service.json.
  const services =
    flows && isLoopbackRuntimeHost(config.host)
      ? new ServiceRuns(flows, randomBytes(32).toString("hex"))
      : undefined;
  const app = createApiApp({
    aiServices,
    codexAuth,
    tripo,
    flows,
    services,
    pluginSettings,
    pluginSettingsAccessible,
    lifecycle,
  });
  const { server, port } = await startHonoServer(app, config.host, config.port);
  const servicePath = services
    ? join(config.root, ".aura", "service.json")
    : undefined;
  try {
    if (services && servicePath)
      await publishDescriptor(servicePath, {
        protocol: "aura-service/1",
        base_url: `${formatHttpUrl(config.host, port)}/services/`,
        token: services.token,
      });
  } catch (error) {
    await closeHonoServer(server);
    throw error;
  }

  return {
    url: formatHttpUrl(config.host, port),
    async close() {
      if (lifecycle.shuttingDown) return;
      lifecycle.shuttingDown = true;
      await closeHonoServer(server);
      if (services && servicePath)
        await removeDescriptor(servicePath, services.token);
    },
  };
}
