import { createFlowApp } from "./flow-routes.ts";
import { flowErrorBody, type ApiErrorDetails } from "@aura/protocol/errors";
import { isTopLevelPluginHttpRequest } from "./plugin-http-mounts.ts";
import {
  FlowError,
  type OrchestrationHost,
  type OrchestrationHealth,
} from "./dsh/host.ts";
import {
  validateMessages,
  validateConversationHistory,
  validateChatModelSelection,
  isCodingPermission,
  isCodingRunIntent,
} from "@aura/protocol";
import type { ChatEvent } from "@aura/protocol/types";
import { Hono, type Context } from "hono";
import type { ChatMessage } from "@aura/protocol/types";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { createCodexAuthApp } from "./codex-auth-routes.ts";
import { createCodingApp } from "./coding-routes.ts";
import { createIntegrationApp } from "./integration-routes.ts";
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
import {
  createPluginPagesApp,
  pluginBundleFallback,
} from "./plugin-pages-routes.ts";
import type { PluginPageRegistry } from "./plugin-pages.ts";
import { isRecord, validCodingImages } from "./validation.ts";
import { isLoopbackRuntimeHost } from "./runtime-config.ts";
import { createAiServicesApp } from "./ai-services-routes.ts";
import { createServiceApp, ServiceRuns } from "./service-routes.ts";
import type { AiServicesPort } from "./ai-services.ts";

interface ApiServerOptions {
  aiServices?: AiServicesPort;
  config: RuntimeConfig;
  codexAuth: CodexAuthPort;
  chat?: ChatPort;
  flows?: OrchestrationHost;
  pluginSettings?: AuraPluginSettingsPort;
  pluginSettingsAccessible?: boolean;
  pluginPages?: PluginPageRegistry;
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

/** Keep legacy text responses while making their meaning available to new clients. */
function chatResponseError(
  context: Context,
  message: string,
  status: 400 | 413 | 503,
  code: ApiErrorDetails["code"],
) {
  context.header("X-Aura-Error-Code", code);
  return context.text(message, status);
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
      onError: (context) =>
        chatResponseError(
          context,
          "无效的对话请求。",
          413,
          "conversation_request_invalid",
        ),
    }),
    async (context) => {
      if (lifecycle.shuttingDown || lifecycle.admittedRequests >= 2)
        return chatResponseError(
          context,
          "服务忙，请稍后再试。",
          503,
          "conversation_service_busy",
        );

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
              {
                sessionId: body.sessionId as string,
                messages,
                ...target,
                ...(body.modelConfig ?? {}),
              },
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
              ...(error instanceof FlowError && error.status === 422
                ? flowErrorBody(error)
                : {
                    message:
                      "DSH 请求暂时不可用，请检查服务终端和登录状态后重试。",
                    code: "chat_request_unavailable",
                  }),
            });
            await pendingWrite;
          } finally {
            lifecycle.admittedRequests--;
          }
        });
      } catch {
        return chatResponseError(
          context,
          "无效的对话请求。",
          400,
          "conversation_request_invalid",
        );
      }
    },
  );
}

/** Builds the complete Hono API without opening a network listener. */
export function createApiApp({
  aiServices,
  codexAuth,
  chat,
  flows,
  pluginSettings,
  pluginSettingsAccessible = true,
  pluginPages,
  services,
  readiness = flows,
  lifecycle = { shuttingDown: false, admittedRequests: 0 },
}: Omit<ApiServerOptions, "config"> & {
  lifecycle?: ApiLifecycle;
  services?: ServiceRuns;
  readiness?: Pick<OrchestrationHost, "health">;
}) {
  const app = new Hono();
  app.use("*", localOriginPolicy);
  if (flows) {
    app.use("*", async (context, next) => {
      const request = context.req.raw;
      if (isTopLevelPluginHttpRequest(new URL(request.url).pathname)) {
        const response = await flows.pluginHttp?.(request);
        if (response) {
          context.header("Cache-Control", "no-store");
          return response;
        }
      }
      await next();
    });
  }
  if (pluginPages) {
    // DSH combo URLs (`/plugins/??id/client.js&rev=`) put the resource list in
    // the query, so they are matched on the raw URL before routing.
    const bundles = pluginBundleFallback(pluginPages);
    app.use("/plugins/", async (context, next) => {
      const response = bundles(context.req.raw);
      if (response) return response;
      await next();
    });
  }

  app.get("/health", async (context) => {
    context.header("Cache-Control", "no-store");
    const dsh: OrchestrationHealth = lifecycle.shuttingDown
      ? { status: "stopped" }
      : ((await readiness
          ?.health()
          .catch(() => ({ status: "unavailable" as const }))) ?? {
          status: "unavailable",
        });
    return context.json(
      {
        service: "aura-runtime",
        status: dsh.status,
        dsh,
        modes: ["dsh-demo", "codex-subscription", "lumina", "custom"],
        keyRequired: false,
      },
      dsh.status === "ready" ? 200 : 503,
    );
  });
  app.route("/auth/codex", createCodexAuthApp(codexAuth));
  if (flows) app.route("/flows", createFlowApp(flows));
  // Coding projects ride on the same host; a runtime without it omits the set.
  if (flows) app.route("/coding", createCodingApp(flows));
  if (flows)
    app.route(
      "/integrations",
      createIntegrationApp(flows, pluginSettingsAccessible),
    );
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
  if (pluginPages)
    app.route("/plugins", createPluginPagesApp(pluginPages, flows));

  app.get("/chat/models", async (context) => {
    const mode = context.req.query("mode") ?? "codex";
    if (!["codex", "demo", "lumina", "custom"].includes(mode))
      return context.json(
        { message: "无效的对话模式。", code: "conversation_mode_invalid" },
        400,
      );
    const host = chat ?? flows;
    if (!host || lifecycle.shuttingDown)
      return context.json(
        {
          message: "对话模型目录暂时不可用。",
          code: "model_catalog_unavailable",
        },
        503,
      );
    try {
      context.header("Cache-Control", "no-store");
      return context.json(
        // Only client disconnect cancels here: the host bounds the catalog
        // read itself, after any cold DSH start, so a start never spends it.
        await host.chatModels(
          mode as ChatRoute["mode"],
          context.req.raw.signal,
        ),
      );
    } catch {
      return context.json(
        {
          message: "无法读取 DSH 模型目录，请重试。",
          code: "model_catalog_unavailable",
        },
        503,
      );
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
      onError: (context) =>
        chatResponseError(
          context,
          "无效的编码请求。",
          413,
          "conversation_request_invalid",
        ),
    }),
    async (context) => {
      if (lifecycle.shuttingDown)
        return chatResponseError(
          context,
          "服务忙，请稍后再试。",
          503,
          "conversation_service_busy",
        );
      const body = (await context.req.json().catch(() => undefined)) as
        Record<string, unknown> | undefined;
      if (
        !isRecord(body) ||
        typeof body.sessionId !== "string" ||
        (body.projectId !== undefined && typeof body.projectId !== "string") ||
        typeof body.prompt !== "string" ||
        body.prompt.length > 80_000 ||
        (body.context !== undefined &&
          (typeof body.context !== "string" || body.context.length > 40_000)) ||
        (body.history !== undefined &&
          !validateConversationHistory(body.history)) ||
        (body.branchFrom !== undefined &&
          (typeof body.branchFrom !== "string" ||
            !body.branchFrom.trim() ||
            body.branchFrom.length > 200)) ||
        (body.branchAt !== undefined &&
          (typeof body.branchAt !== "number" ||
            !Number.isSafeInteger(body.branchAt) ||
            body.branchAt < 0 ||
            typeof body.branchFrom !== "string")) ||
        !validCodingImages(body.images) ||
        (body.forkFrom !== undefined &&
          (typeof body.forkFrom !== "string" ||
            !body.forkFrom.trim() ||
            body.forkFrom.length > 200)) ||
        // An image-only request is allowed; an empty one is not.
        (!body.prompt.trim() &&
          !(body.images as string[] | undefined)?.length) ||
        !["codex", "lumina", "custom", "demo"].includes(String(body.mode)) ||
        (body.modelConfig !== undefined &&
          !validateChatModelSelection(body.modelConfig)) ||
        (body.permission !== undefined &&
          !isCodingPermission(body.permission)) ||
        (body.intent !== undefined && !isCodingRunIntent(body.intent)) ||
        ((body.intent === "goal" || body.intent === "resume-goal") &&
          !!(body.images as string[] | undefined)?.length)
      )
        return chatResponseError(
          context,
          "无效的编码请求。",
          400,
          "conversation_request_invalid",
        );
      if (!chat && !flows)
        return chatResponseError(
          context,
          "编码服务不可用。",
          503,
          "coding_request_unavailable",
        );
      const host = chat ?? flows;
      const coding = host?.coding?.bind(host);
      if (!coding)
        return chatResponseError(
          context,
          "编码服务不可用。",
          503,
          "coding_request_unavailable",
        );

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
              ...(Array.isArray(body.history)
                ? { history: body.history as ChatMessage[] }
                : {}),
              ...(typeof body.context === "string"
                ? { context: body.context }
                : {}),
              ...(typeof body.branchFrom === "string"
                ? { branchFrom: body.branchFrom }
                : {}),
              ...(typeof body.branchAt === "number"
                ? { branchAt: body.branchAt }
                : {}),
              prompt: body.prompt as string,
              ...((body.images as string[] | undefined)?.length
                ? { images: body.images as string[] }
                : {}),
              ...(typeof body.forkFrom === "string"
                ? { forkFrom: body.forkFrom }
                : {}),
              mode,
              ...(selection?.model ? { model: selection.model } : {}),
              ...(selection?.reasoningEffort
                ? { reasoningEffort: selection.reasoningEffort }
                : {}),
              ...(isCodingPermission(body.permission)
                ? { permission: body.permission }
                : {}),
              ...(isCodingRunIntent(body.intent)
                ? { intent: body.intent }
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
            // Validation failures are safe; anything else stays generic.
            ...(error instanceof FlowError && error.status < 500
              ? flowErrorBody(error)
              : {
                  message:
                    "编码请求暂时不可用，请检查服务终端和登录状态后重试。",
                  code: "coding_request_unavailable",
                }),
          });
          await pendingWrite;
        }
      });
    },
  );

  app.notFound((context) => context.body(null, 404));
  app.onError(
    () =>
      new Response(
        JSON.stringify({
          message: "Aura runtime 请求处理失败。",
          code: "runtime_request_failed",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      ),
  );
  return app;
}

/** Starts the local Aura HTTP boundary over injected runtime services. */
export async function startApiServer({
  aiServices,
  config,
  codexAuth,
  flows,
  pluginSettings,
  pluginSettingsAccessible,
  pluginPages,
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
    flows,
    services,
    pluginSettings,
    pluginSettingsAccessible,
    pluginPages,
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
