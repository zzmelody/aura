import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { artifactResponse, type ArtifactFile } from "./artifacts/http.ts";
import { GeneratedArtifacts } from "./artifacts/generated.ts";
import { videoRoutes } from "./video/routes.ts";
import { contentRoutes } from "./content/routes.ts";
import { topicRoutes } from "./topics/routes.ts";
import { contentAnalyticsRoutes } from "./content/analytics-routes.ts";
import { storeContentBytes } from "./content/media.ts";
import { ActionFailure } from "./action-api.ts";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import type {
  ActionRun,
  ChatModelCatalog,
  FlowCatalog,
  FlowMode,
  FlowRun,
} from "@aura/protocol/types";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  defaultActionRoot,
  defaultFlowRoot,
  dshBin,
  provisionProfile,
} from "./profile.ts";
import { FlowError, jsonValue } from "./schema.ts";
export { FlowError } from "./schema.ts";
import type {
  ChatStreamEvent,
  ChatTurn,
  CodingConversation,
  CodingHistoryTurn,
  CodingProject,
  CodingQuestionAnswer,
  CodingStreamEvent,
  CodingTurn,
} from "./types.ts";
import type {
  ContributionConfiguration,
  FlowRpcResult,
  HostOptions,
} from "./types.ts";

export interface InvokeFlowOptions {
  input: unknown;
  mode: FlowMode;
  requestId?: string;
  signal?: AbortSignal;
}

/** One lazy long-lived DSH host, independent of browser request lifetimes. */
export class OrchestrationHost {
  options: HostOptions;
  opening: ReturnType<OrchestrationHost["launch"]> | undefined;
  closed = false;
  /** Per-request listeners for `chat/event` notifications from the DSH host. */
  readonly chatListeners = new Map<string, (event: ChatStreamEvent) => void>();
  /** Coding turns stream over the same channel under their own ids. */
  readonly codingListeners = new Map<
    string,
    (event: CodingStreamEvent) => void
  >();

  constructor(options: HostOptions) {
    this.options = { ...options };
  }

  /** Serves one uploaded image by content ID, for chat thumbnails. */
  async imageAssetContent(assetId: string, request: Request) {
    if (!/^[a-f0-9]{64}$/u.test(assetId))
      throw new FlowError("图片不存在。", 404);
    const root = join(this.options.dshHome, "aura-generated-assets");
    for (const format of ["png", "jpeg", "webp"] as const) {
      try {
        await stat(join(root, `${assetId}.${format}`));
      } catch {
        continue;
      }
      return artifactResponse(
        root,
        {
          artifact: { name: `image.${format}`, mimeType: `image/${format}` },
          fileId: assetId,
          format,
        },
        request,
        false,
      );
    }
    throw new FlowError("图片不存在。", 404);
  }

  /** Admit browser uploads without sending binary data through the DSH JSON-RPC link. */
  async uploadImage(bytes: Uint8Array, signal: AbortSignal) {
    return new GeneratedArtifacts(
      join(this.options.dshHome, "aura-generated-assets"),
    ).registerImage(bytes, signal);
  }

  async artifactContent(
    id: string,
    artifactId: string,
    thumbnail: boolean,
    request: Request,
  ) {
    const descriptor = await this.request<ArtifactFile>(
      "artifacts/resolve",
      { id, artifactId, thumbnail },
      request.signal,
    );
    return artifactResponse(
      join(this.options.dshHome, "aura-generated-assets"),
      descriptor,
      request,
      thumbnail,
    );
  }

  async videoAssetContent(id: string, assetId: string, request: Request) {
    const descriptor = await this.request<ArtifactFile>(
      "video-projects/asset",
      { id, assetId },
      request.signal,
    );
    return artifactResponse(
      join(this.options.dshHome, "aura-generated-assets"),
      descriptor,
      request,
      false,
    );
  }

  async uploadContentAsset(
    bytes: Uint8Array,
    name: string,
    mime: string,
    signal: AbortSignal,
  ) {
    if (bytes.length > (mime === "video/mp4" ? 200 : 32) * 1024 * 1024)
      throw new FlowError("素材超过上传大小限制。", 413);
    const asset = await storeContentBytes(
      new GeneratedArtifacts(
        join(this.options.dshHome, "aura-generated-assets"),
      ),
      bytes,
      name,
      signal,
    );
    if (asset.mimeType !== mime || !["image", "video"].includes(asset.kind))
      throw new FlowError("素材内容与声明格式不匹配。", 415);
    return { ...asset, uploaded: true };
  }

  async contentAssetContent(id: string, assetId: string, request: Request) {
    const descriptor = await this.request<ArtifactFile>(
      "content-projects/asset",
      { id, assetId },
      request.signal,
    );
    return artifactResponse(
      join(this.options.dshHome, "aura-generated-assets"),
      descriptor,
      request,
      false,
    );
  }

  async topicAssetContent(id: string, assetId: string, request: Request) {
    const descriptor = await this.request<ArtifactFile>(
      "topic-library/asset",
      { id, assetId },
      request.signal,
    );
    return artifactResponse(
      join(this.options.dshHome, "aura-generated-assets"),
      descriptor,
      request,
      false,
    );
  }

  async open() {
    if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
    this.opening ??= this.launch().catch((error) => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }

  async launch() {
    const { root, dshHome, modelURL, codexModel } = this.options;
    const flowRoot = this.options.flowRoot ?? defaultFlowRoot;
    const actionRoot = this.options.actionRoot ?? defaultActionRoot;
    const flowRoots = [{ root: flowRoot }, ...(this.options.flowRoots ?? [])];
    const actionRoots = [
      { root: actionRoot },
      ...(this.options.actionRoots ?? []),
    ];
    await provisionProfile(
      dshHome,
      flowRoots.map((entry) => entry.pluginRoot ?? entry.root),
      actionRoots.map((entry) => entry.pluginRoot ?? entry.root),
      root,
    );
    const child = spawn(
      process.execPath,
      ["--expose-internals", dshBin, "--profile", "aura-flow"],
      {
        cwd: root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          AURA_FLOW_CWD: root,
          AURA_FLOW_ROOT: flowRoot,
          AURA_ACTION_ROOT: actionRoot,
          AURA_FLOW_ROOTS: JSON.stringify(flowRoots),
          AURA_ACTION_ROOTS: JSON.stringify(actionRoots),
          AURA_PLUGIN_STATUSES: JSON.stringify(this.options.plugins ?? []),
          AURA_CAPABILITY_ROOTS: JSON.stringify(
            this.options.capabilityRoots ?? [],
          ),
          ...(this.options.tripoCredentialPath
            ? {
                AURA_TRIPO_CREDENTIAL_PATH: this.options.tripoCredentialPath,
                AURA_TRIPO_REGION: this.options.tripoRegion ?? "global",
              }
            : {}),
          AURA_CODEX_MODEL: codexModel || "gpt-6.1-sol",
          AURA_DEMO_KEY: "demo-only-not-a-real-key",
          AURA_DEMO_BASE_URL: modelURL,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
      },
    );
    const rpc = new JsonRpcLineTransport(child.stdout, child.stdin);
    // DSH/provider logs may contain credentials; never forward raw stderr.
    child.stderr.resume();
    const exited = new Promise<void>((resolve) => {
      child.once("error", () => {
        rpc.close();
        resolve();
      });
      child.once("exit", () => {
        rpc.close();
        this.opening = undefined;
        resolve();
      });
    });
    rpc.onNotification((method, params) => {
      if (method !== "chat/event" || typeof params.chatId !== "string") return;
      const listener = this.chatListeners.get(params.chatId);
      if (listener) {
        listener(params.event as ChatStreamEvent);
        return;
      }
      this.codingListeners.get(params.chatId)?.(
        params.event as CodingStreamEvent,
      );
    });
    rpc.start();
    try {
      const result = (await rpc.request(
        "initialize",
        {},
        AbortSignal.timeout(30_000),
      )) as FlowRpcResult<{ name: string; version: number }>;
      if (
        !result.ok ||
        result.data.name !== "aura-orchestration" ||
        result.data.version !== 4
      )
        throw new Error("Invalid host handshake");
      return { child, rpc, exited };
    } catch {
      rpc.close();
      child.kill();
      await exited;
      throw new FlowError(
        "DSH 编排服务启动失败，请检查 preset、依赖和 Flow 目录。",
        503,
      );
    }
  }

  async request<T = unknown>(
    method: string,
    params: object = {},
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<T> {
    const { rpc } = await this.open();
    let result: FlowRpcResult<T>;
    try {
      result = (await rpc.request(method, params, signal)) as FlowRpcResult<T>;
    } catch {
      throw new FlowError(
        "编排连接已中断。运行状态可能已保存，请刷新确认。",
        503,
      );
    }
    if (!result.ok) throw new FlowError(result.message, result.status);
    return result.data;
  }

  /**
   * Streams one chat turn through the long-lived DSH host, where the model may
   * start chat workflows as tools. Events arrive before the request settles.
   */
  chatModels(mode: FlowMode, signal: AbortSignal): Promise<ChatModelCatalog> {
    return this.request("chat/models", { mode }, signal);
  }

  async chat(
    turn: ChatTurn,
    emit: (event: ChatStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }> {
    const chatId = randomUUID();
    this.chatListeners.set(chatId, emit);
    const { rpc } = await this.open();
    const onAbort = () => rpc.notify("chat/cancel", { chatId });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.request<{ model: string }>(
        "chat",
        { chatId, ...turn },
        AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.chatListeners.delete(chatId);
    }
  }

  /**
   * Streams one turn of a persistent coding conversation. The session is bound
   * to a project directory and keeps its agent across turns, so the model can
   * read, edit and run code there with its tool history intact.
   */
  async coding(
    // The backend resolves the directory and mode defaults itself.
    turn: Omit<CodingTurn, "project" | "defaults">,
    emit: (event: CodingStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }> {
    const chatId = randomUUID();
    this.codingListeners.set(chatId, emit);
    const { rpc } = await this.open();
    const onAbort = () => rpc.notify("chat/cancel", { chatId });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.request<{ model: string }>(
        "coding",
        { chatId, ...turn },
        AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.codingListeners.delete(chatId);
    }
  }

  /** Project list and lifecycle for coding mode. */
  projects(): Promise<CodingProject[]> {
    return this.request<CodingProject[]>("coding/projects");
  }

  createProject(directory: string, title?: string): Promise<CodingProject> {
    return this.request<CodingProject>("coding/projects/create", {
      directory,
      ...(title ? { title } : {}),
    });
  }

  renameProject(id: string, title: string): Promise<CodingProject> {
    return this.request<CodingProject>("coding/projects/rename", { id, title });
  }

  removeProject(id: string): Promise<boolean> {
    return this.request<boolean>("coding/projects/remove", { id });
  }

  projectStatus(id: string): Promise<"ok" | "missing-dir"> {
    return this.request<"ok" | "missing-dir">("coding/projects/status", {
      id,
    });
  }

  /** Delivers the user's answer to a question a coding agent is waiting on. */
  answerCoding(
    sessionId: string,
    questionId: string,
    answers: CodingQuestionAnswer[],
  ): Promise<{ accepted: boolean }> {
    return this.request<{ accepted: boolean }>("coding/answer", {
      sessionId,
      questionId,
      answers,
    });
  }

  /** A coding conversation rebuilt from its stored session log. */
  codingHistory(
    sessionId: string,
  ): Promise<{ turns: CodingHistoryTurn[]; running: boolean }> {
    return this.request<{ turns: CodingHistoryTurn[]; running: boolean }>(
      "coding/history",
      { sessionId },
    );
  }

  conversations(projectId: string): Promise<CodingConversation[]> {
    return this.request<CodingConversation[]>("coding/conversations", {
      projectId,
    });
  }

  /** Direct backend invocation using the same durable engine as HTTP calls. */
  async invokeFlow(
    flowId: string,
    options: InvokeFlowOptions,
  ): Promise<FlowRun> {
    options.signal?.throwIfAborted();
    const run = await this.request<FlowRun>("start", {
      requestId: options.requestId ?? randomUUID(),
      flowId,
      mode: options.mode,
      input: jsonValue(options.input, "Flow 入参"),
    });
    const signal = options.signal ?? new AbortController().signal;
    try {
      return await this.request<FlowRun>("wait", { id: run.id }, signal);
    } catch (error) {
      if (signal.aborted) {
        await this.request("cancel", {
          id: run.id,
          requestId: randomUUID(),
        }).catch(() => undefined);
        throw signal.reason;
      }
      throw error;
    }
  }

  /** Atomically applies trusted plugin contribution roots to this live host. */
  async configureContributions(
    configuration: ContributionConfiguration,
  ): Promise<void> {
    const flowRoot = this.options.flowRoot ?? defaultFlowRoot;
    const actionRoot = this.options.actionRoot ?? defaultActionRoot;
    const next = {
      flowRoots: [{ root: flowRoot }, ...configuration.flowRoots],
      actionRoots: [{ root: actionRoot }, ...configuration.actionRoots],
      capabilityRoots: configuration.capabilityRoots,
      plugins: configuration.plugins,
    };
    await this.request("plugins/configure", next, AbortSignal.timeout(60_000));
    this.options.flowRoots = configuration.flowRoots.map((root) => ({
      ...root,
      ...(root.plugin ? { plugin: { ...root.plugin } } : {}),
    }));
    this.options.actionRoots = configuration.actionRoots.map((root) => ({
      ...root,
      ...(root.plugin ? { plugin: { ...root.plugin } } : {}),
    }));
    this.options.capabilityRoots = structuredClone(
      configuration.capabilityRoots,
    );
    this.options.plugins = configuration.plugins.map((plugin) => ({
      ...plugin,
    }));
  }

  async close() {
    this.closed = true;
    if (!this.opening) return;
    const host = await this.opening.catch(() => undefined);
    if (!host) return;
    try {
      await host.rpc.request("shutdown", {}, AbortSignal.timeout(10_000));
    } catch {}
    host.rpc.close();
    host.child.stdin.end();
    const timer = setTimeout(() => host.child.kill(), 3_000);
    await host.exited;
    clearTimeout(timer);
  }

  /** Local-only API. Same Action/DSH execution pipeline used by ctx.action(). */
  async invokeAction(
    actionId: string,
    options: InvokeFlowOptions,
  ): Promise<ActionRun> {
    options.signal?.throwIfAborted();
    const run = await this.request<ActionRun>("action/start", {
      requestId: options.requestId ?? randomUUID(),
      actionId,
      mode: options.mode,
      input: jsonValue(options.input, "Action 入参"),
    });
    const signal = options.signal ?? new AbortController().signal;
    try {
      return await this.request<ActionRun>(
        "action/wait",
        { id: run.id },
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        await this.request("action/cancel", { id: run.id }).catch(
          () => undefined,
        );
        throw signal.reason;
      }
      throw error;
    }
  }
}

async function readBody(context: Context): Promise<Record<string, unknown>> {
  try {
    const value = (await context.req.json()) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Invalid object");
    return value as Record<string, unknown>;
  } catch {
    throw new FlowError("Flow 请求必须是有效的 JSON 对象。");
  }
}

/** Builds the Hono router mounted by runtime under the `/flows` namespace. */
export function createFlowApp(
  host: Pick<OrchestrationHost, "request"> &
    Partial<
      Pick<
        OrchestrationHost,
        | "artifactContent"
        | "uploadImage"
        | "imageAssetContent"
        | "videoAssetContent"
        | "uploadContentAsset"
        | "contentAssetContent"
        | "topicAssetContent"
      >
    >,
) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", (context, next) =>
    bodyLimit({
      maxSize:
        context.req.method === "POST" &&
        /(?:^|\/)content-projects\/[^/]+\/assets$/.test(context.req.path)
          ? 200 * 1024 * 1024
          : /(?:^|\/)content-projects(?:\/|$)/.test(context.req.path)
            ? 2 * 1024 * 1024
            : context.req.method === "POST" &&
                (context.req.path === "/assets/images" ||
                  /^\/video-projects\/[^/]+\/images$/.test(context.req.path))
              ? 32 * 1024 * 1024
              : context.req.path.startsWith("/video-projects")
                ? 2 * 1024 * 1024
                : 256 * 1_024,
      onError: (context) => context.json({ message: "Flow 请求过大。" }, 413),
    })(context, next),
  );

  app.get("/assets/images/:id", async (context) => {
    if (!host.imageAssetContent)
      throw new FlowError("图片资产服务不可用。", 503);
    return host.imageAssetContent(context.req.param("id"), context.req.raw);
  });

  app.post("/assets/images", async (context) => {
    if (!host.uploadImage) throw new FlowError("图片资产服务不可用。", 503);
    const mediaType = context.req
      .header("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType ?? ""))
      throw new FlowError("请上传 PNG、JPEG 或 WebP 图片。", 415);
    const bytes = new Uint8Array(await context.req.arrayBuffer());
    try {
      const asset = await host.uploadImage(bytes, context.req.raw.signal);
      return context.json(
        {
          assetId: asset.artifactId,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          bytes: asset.bytes,
        },
        201,
      );
    } catch (error) {
      if (context.req.raw.signal.aborted) throw error;
      if (error instanceof ActionFailure)
        throw new FlowError(error.message, 400);
      throw error;
    }
  });

  app.route("/video-projects", videoRoutes(host));
  app.route("/content-projects", contentRoutes(host));
  app.route("/topic-library", topicRoutes(host));
  app.route("/content-analytics", contentAnalyticsRoutes(host));

  app.get("/catalog", async (context) =>
    context.json(await host.request("catalog")),
  );
  app.get("/services", async (context) => {
    const catalog = await host.request<FlowCatalog>("catalog");
    return context.json({
      flows: catalog.flows
        .filter((flow) => flow.available && flow.service)
        .map((flow) => ({
          ...flow,
          invokePath: `/flows/${encodeURIComponent(flow.id)}/invoke`,
        })),
    });
  });
  app.get("/runs", async (context) => context.json(await host.request("list")));
  app.get("/runs/:id/artifacts", async (context) =>
    context.json(
      await host.request("artifacts/list", {
        id: context.req.param("id"),
        retry: context.req.query("retry") === "1",
      }),
    ),
  );
  for (const variant of ["content", "thumbnail"] as const) {
    app.on(
      ["GET", "HEAD"],
      `/runs/:id/artifacts/:artifactId/${variant}`,
      async (context) => {
        if (!host.artifactContent)
          throw new FlowError("产物读取服务不可用。", 503);
        return host.artifactContent(
          context.req.param("id"),
          context.req.param("artifactId"),
          variant === "thumbnail",
          context.req.raw,
        );
      },
    );
  }
  app.get("/:flowId/source", async (context) =>
    context.json(
      await host.request("source", { id: context.req.param("flowId") }),
    ),
  );
  app.get("/runs/:id", async (context) =>
    context.json(await host.request("get", { id: context.req.param("id") })),
  );
  for (const method of ["cancel", "pause", "resume"] as const)
    app.post(`/runs/:id/${method}`, async (context) =>
      context.json(
        await host.request(method, {
          ...(await readBody(context)),
          id: context.req.param("id"),
        }),
      ),
    );
  for (const method of ["answer", "resolve"] as const)
    app.post(`/runs/:id/steps/:stepKey/${method}`, async (context) =>
      context.json(
        await host.request(method, {
          ...(await readBody(context)),
          id: context.req.param("id"),
          stepKey: context.req.param("stepKey"),
        }),
      ),
    );
  app.get("/runs/:id/steps/:stepId/history", async (context) => {
    const beforeSeq = context.req.query("beforeSeq");
    const attempt = context.req.query("attempt");
    return context.json(
      await host.request("history", {
        id: context.req.param("id"),
        stepId: context.req.param("stepId"),
        ...(beforeSeq === undefined ? {} : { beforeSeq: Number(beforeSeq) }),
        ...(attempt === undefined ? {} : { attempt: Number(attempt) }),
      }),
    );
  });
  app.post("/:flowId/runs", async (context) => {
    const body = await readBody(context);
    const run = await host.request<FlowRun>("start", {
      ...body,
      flowId: context.req.param("flowId"),
    });
    return context.json({ runId: run.id }, 202);
  });
  app.post("/:flowId/invoke", async (context) => {
    const body = await readBody(context);
    const headerRequestId = context.req.header("Idempotency-Key")?.trim();
    if (
      headerRequestId &&
      typeof body.requestId === "string" &&
      body.requestId !== headerRequestId
    )
      throw new FlowError("Idempotency-Key 与请求体 requestId 必须一致。", 409);
    const requestId = headerRequestId || body.requestId || randomUUID();
    const run = await host.request<FlowRun>("start", {
      ...body,
      requestId,
      flowId: context.req.param("flowId"),
      serviceOnly: true,
    });
    const self = `/flows/runs/${encodeURIComponent(run.id)}`;
    context.header("Location", self);
    return context.json(
      {
        runId: run.id,
        requestId: run.requestId,
        status: run.status,
        links: {
          self,
          cancel: `${self}/cancel`,
        },
      },
      202,
    );
  });

  app.all("*", (context) => context.json({ message: "编排接口不存在。" }, 404));
  app.onError((error, context) => {
    const status = error instanceof FlowError ? error.status : 500;
    return context.json(
      {
        message: error instanceof FlowError ? error.message : "编排请求失败。",
      },
      status as ContentfulStatusCode,
    );
  });
  return app;
}
