import type {
  CodingSubagent,
  CodingCapabilities,
  CodingCompactionResult,
} from "@aura/protocol/types";
import { PluginHttpRegistry } from "./plugin-http.ts";
import {
  defaultPluginSdkPackage,
  installHostPluginSdkResolution,
  PLUGIN_SDK_ENV,
} from "./plugin-sdk-resolution.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { artifactResponse, type ArtifactFile } from "./artifacts/http.ts";
import { GeneratedArtifacts } from "./artifacts/generated.ts";
import { ActionFailure } from "./action-api.ts";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import type {
  ActionRun,
  ChatModelCatalog,
  ChatModelSelection,
  CodingSteerModelConfig,
  CodingSkillInfo,
  CodingHistoryPage,
  PersonalAssistantInfo,
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
import {
  HostDiagnosticReader,
  HostLogger,
  hostErrorDiagnostic,
  hostErrorDiagnostics,
} from "./host-diagnostics.ts";
export { FlowError } from "./schema.ts";
import type {
  ChatStreamEvent,
  ChatTurn,
  CodingConversation,
  CodingProject,
  CodingQuestionAnswer,
  CodingStreamEvent,
  CodingTurn,
} from "./types.ts";
import type { AutomationHistory, AutomationTask } from "@aura/protocol/types";
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

export interface OrchestrationHealth {
  status: "starting" | "ready" | "unavailable" | "stopped";
}

interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcLineTransport;
  exited: Promise<void>;
}

/** One lazy long-lived DSH host, independent of browser request lifetimes. */
export class OrchestrationHost {
  options: HostOptions;
  opening: ReturnType<OrchestrationHost["launch"]> | undefined;
  closed = false;
  private running: HostProcess | undefined;
  private phase: OrchestrationHealth["status"] = "unavailable";
  private probing: Promise<OrchestrationHealth> | undefined;
  private startupAbort: AbortController | undefined;
  private readonly logger: HostLogger;
  /** Per-request listeners for `chat/event` notifications from the DSH host. */
  readonly chatListeners = new Map<string, (event: ChatStreamEvent) => void>();
  /** Coding turns stream over the same channel under their own ids. */
  readonly codingListeners = new Map<
    string,
    (event: CodingStreamEvent) => void
  >();

  private pluginHttpRegistry: PluginHttpRegistry;
  private pluginHttpReady: Promise<void> | undefined;
  private createPluginHttp() {
    return new PluginHttpRegistry({
      request: (method, input, signal) =>
        this.request(method, input as object | undefined, signal),
      artifacts: new GeneratedArtifacts(
        join(this.options.dshHome, "aura-generated-assets"),
      ),
      artifactContent: (descriptor, request) =>
        artifactResponse(
          join(this.options.dshHome, "aura-generated-assets"),
          descriptor,
          request,
          false,
        ),
    });
  }
  async pluginHttp(request: Request) {
    await (this.pluginHttpReady ??= this.pluginHttpRegistry.replace(
      this.options.backendRoots ?? [],
    ));
    return this.pluginHttpRegistry.fetch(request);
  }
  constructor(options: HostOptions) {
    // Plugin HTTP contributions load in this process.
    options.pluginSdkPackage ??= defaultPluginSdkPackage();
    installHostPluginSdkResolution(options.pluginSdkPackage);
    this.options = { ...options };
    this.logger = new HostLogger(options.dshHome);
    this.pluginHttpRegistry = this.createPluginHttp();
  }

  /** Readiness never starts DSH or waits for a cold start. Probe the current RPC listener. */
  async health(): Promise<OrchestrationHealth> {
    if (this.closed) return { status: "stopped" };
    const running = this.running;
    if (!running) return { status: this.phase };
    this.probing ??= (async (): Promise<OrchestrationHealth> => {
      try {
        const result = (await running.rpc.request(
          "ping",
          {},
          AbortSignal.timeout(500),
        )) as FlowRpcResult<unknown>;
        return {
          status:
            result.ok && this.running === running && !this.closed
              ? "ready"
              : "unavailable",
        };
      } catch {
        return { status: "unavailable" };
      }
    })().finally(() => {
      this.probing = undefined;
    });
    return this.probing;
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

  async open() {
    if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
    if (!this.opening) {
      this.phase = "starting";
      this.opening = this.launch().catch((error: unknown) => {
        this.opening = undefined;
        this.phase = this.closed ? "stopped" : "unavailable";
        if (!this.closed)
          for (const diagnostic of hostErrorDiagnostics(error))
            this.logger.write("startup-failed", diagnostic);
        throw new FlowError(
          "DSH 编排服务启动失败，请查看 .aura/dsh/logs/aura-host.log。",
          503,
        );
      });
    }
    return this.opening;
  }

  async launch(): Promise<HostProcess> {
    const { root, dshHome, modelURL, codexModel } = this.options;
    const flowRoot = this.options.flowRoot ?? defaultFlowRoot;
    const actionRoot = this.options.actionRoot ?? defaultActionRoot;
    const flowRoots = [{ root: flowRoot }, ...(this.options.flowRoots ?? [])];
    const actionRoots = [
      { root: actionRoot },
      ...(this.options.actionRoots ?? []),
    ];
    // Conversations outside any workspace run in this built-in directory.
    const defaultWorkspace =
      this.options.defaultWorkspace ?? join(root, ".aura", "workspace");
    await mkdir(defaultWorkspace, { recursive: true });
    // Disposable scratch space handed to Actions and plugin backends.
    const tempDir = this.options.tempDir ?? join(root, "local", "runtime");
    await mkdir(tempDir, { recursive: true });
    await provisionProfile(
      dshHome,
      flowRoots.map((entry) => entry.pluginRoot ?? entry.root),
      actionRoots.map((entry) => entry.pluginRoot ?? entry.root),
      root,
      modelURL,
    );
    if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
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
          AURA_DEFAULT_WORKSPACE: defaultWorkspace,
          AURA_TEMP_DIR: tempDir,
          AURA_FLOW_ROOT: flowRoot,
          AURA_ACTION_ROOT: actionRoot,
          AURA_FLOW_ROOTS: JSON.stringify(flowRoots),
          AURA_ACTION_ROOTS: JSON.stringify(actionRoots),
          AURA_PLUGIN_STATUSES: JSON.stringify(this.options.plugins ?? []),
          AURA_BACKEND_ROOTS: JSON.stringify(this.options.backendRoots ?? []),
          [PLUGIN_SDK_ENV]: this.options.pluginSdkPackage,
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
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    const diagnostics = new HostDiagnosticReader(
      (error) => this.logger.write("plugin-error", error),
      () => startupAbort.abort(new Error("Aura plugin did not activate")),
    );
    // Only the allowlisted Cordis error projection reaches terminal/local logs.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => diagnostics.push(chunk));
    let ready = false;
    const exited = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        this.logger.write("process-error", hostErrorDiagnostic(error));
        rpc.close();
        resolve();
      });
      child.once("exit", (code, signal) => {
        rpc.close();
        if (this.running?.child === child) this.running = undefined;
        this.phase = this.closed ? "stopped" : "unavailable";
        if (!this.closed)
          this.logger.write(`process-exit:${code ?? signal ?? "unknown"}`);
        this.opening = undefined;
        resolve();
        // The host is meant to stay up for the runtime's lifetime. Bring back
        // one that crashed after a good start; a failed handshake is left to
        // the next request so a broken profile cannot restart in a loop.
        if (ready && !this.closed)
          setTimeout(() => {
            if (!this.closed && !this.opening)
              this.open().catch(() => undefined);
          }, 2_000).unref();
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
      // A cold DSH start loads its profile and TypeScript sources and has been
      // measured at 20–35 s on Windows, so 30 s rejected healthy starts.
      const result = (await rpc.request(
        "initialize",
        {},
        AbortSignal.any([startupAbort.signal, AbortSignal.timeout(120_000)]),
      )) as FlowRpcResult<{ name: string; version: number }>;
      if (
        !result.ok ||
        result.data.name !== "aura-orchestration" ||
        result.data.version !== 4
      )
        throw new Error("Invalid host handshake");
      ready = true;
      this.startupAbort = undefined;
      const host = { child, rpc, exited };
      this.running = host;
      this.phase = "ready";
      // A host can stay alive yet stop answering (its RPC listener detached),
      // and an exit-only watch never notices. Requests run concurrently, so a
      // ping is not queued behind long work; three misses in a row (about 90 s
      // of silence) mean the host is gone, and killing it triggers the crash
      // restart above.
      let missed = 0;
      const liveness = setInterval(() => {
        rpc
          .request("ping", {}, AbortSignal.timeout(15_000))
          .then(() => {
            missed = 0;
          })
          .catch(() => {
            if (++missed < 3 || this.closed) return;
            this.logger.write("rpc-unresponsive:restarting");
            child.kill();
          });
      }, 30_000);
      liveness.unref();
      child.once("exit", () => clearInterval(liveness));
      return host;
    } catch (error) {
      rpc.close();
      child.kill();
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(killTimer);
      this.startupAbort = undefined;
      throw error;
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
   * Reads the model catalog from the DSH host that executes chat. The caller's
   * signal bounds only the catalog request: a cold host start (20–35 s on
   * Windows, at runtime start or after a crash) has its own handshake timeout
   * and must not spend the catalog's budget.
   */
  async chatModels(
    mode: FlowMode,
    signal: AbortSignal,
  ): Promise<ChatModelCatalog> {
    await this.open();
    signal.throwIfAborted();
    return this.request(
      "chat/models",
      { mode },
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    );
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

  personalAssistant(create = false): Promise<PersonalAssistantInfo | null> {
    return this.request("coding/assistant", { create });
  }

  skills(projectId: string): Promise<CodingSkillInfo[]> {
    return this.request<CodingSkillInfo[]>("coding/skills", { projectId });
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

  /** Moves a project to another directory, keeping its title. */
  relocateProject(id: string, directory: string): Promise<CodingProject> {
    return this.request<CodingProject>("coding/projects/relocate", {
      id,
      directory,
    });
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

  /** Stops a conversation's running turn and resolves once it has settled. */
  codingSubagents(sessionId: string) {
    return this.request<CodingSubagent[]>("coding/agents", { sessionId });
  }
  stopCodingSubagent(sessionId: string, childId: string) {
    return this.request<{ accepted: true }>("coding/agents/stop", {
      sessionId,
      childId,
    });
  }

  codingCapabilities(source?: unknown) {
    return this.request<CodingCapabilities>(
      source === undefined ? "coding/capabilities" : "coding/capabilities/save",
      source ?? {},
    );
  }

  compactCoding(sessionId: string) {
    return this.request<CodingCompactionResult>(
      "coding/compact",
      { sessionId },
      AbortSignal.timeout(5 * 60_000),
    );
  }

  stopCoding(sessionId: string): Promise<{ stopped: boolean }> {
    return this.request<{ stopped: boolean }>("coding/stop", { sessionId });
  }

  /**
   * Steers a conversation's running turn: the guidance joins the turn in
   * progress, whose own stream keeps carrying what the model does with it.
   * Reports `steered: false` when nothing is running to receive it.
   */
  steerCoding(
    sessionId: string,
    prompt: string,
    images?: string[],
    modelConfig?: CodingSteerModelConfig,
  ): Promise<{ steered: boolean }> {
    return this.request<{ steered: boolean }>("coding/steer", {
      sessionId,
      prompt,
      ...(images?.length ? { images } : {}),
      ...(modelConfig ? { modelConfig } : {}),
    });
  }

  /** Durably opens an empty side chat, or returns the parent's existing one. */
  openCodingSide(sessionId: string): Promise<{ sessionId: string }> {
    return this.request<{ sessionId: string }>("coding/side/open", {
      sessionId,
    });
  }

  archiveCodingConversation(
    sessionId: string,
    archived: boolean,
  ): Promise<void> {
    return this.request<void>("coding/conversation/archive", {
      sessionId,
      archived,
    });
  }

  closeCodingConversation(sessionId: string): Promise<void> {
    return this.request<void>("coding/conversation/close", { sessionId });
  }

  /** Discards a side chat: stops its turn and disposes its agent. */
  closeCodingSide(sessionId: string): Promise<{ closed: boolean }> {
    return this.request<{ closed: boolean }>("coding/side/close", {
      sessionId,
    });
  }

  /** Automation tasks: DSH Schedule reminders on coding conversations. */
  automationTasks(): Promise<AutomationTask[]> {
    return this.request<AutomationTask[]>("automation/list");
  }

  /** `input` is a request body; the orchestration plugin validates it. */
  createAutomationTask(
    input: Record<string, unknown>,
  ): Promise<AutomationTask> {
    return this.request<AutomationTask>("automation/create", input);
  }

  updateAutomationTask(
    id: string,
    input: Record<string, unknown>,
  ): Promise<AutomationTask> {
    return this.request<AutomationTask>("automation/update", { id, ...input });
  }

  deleteAutomationTask(
    sessionId: string,
    id: string,
  ): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>("automation/delete", {
      sessionId,
      id,
    });
  }

  automationHistory(sessionId: string, id: string): Promise<AutomationHistory> {
    return this.request<AutomationHistory>("automation/history", {
      sessionId,
      id,
    });
  }

  /** A coding conversation rebuilt from its stored session log. */
  async codingHistory(
    sessionId: string,
    options: { page?: boolean; beforeSeq?: number; throughSeq?: number } = {},
    signal?: AbortSignal,
  ): Promise<Omit<CodingHistoryPage, "hasMore"> & { hasMore?: boolean }> {
    if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
    const readSignal = signal ?? AbortSignal.timeout(30_000);
    readSignal.throwIfAborted();
    if (!this.running && options.page) {
      try {
        const { coldCodingHistory } = await import("./coding/cold-history.ts");
        const page = await coldCodingHistory(
          this.options.dshHome,
          sessionId,
          options,
          readSignal,
        );
        readSignal.throwIfAborted();
        if (page && !this.running && !this.closed) return page;
      } catch (error) {
        readSignal.throwIfAborted();
        if (
          !this.running &&
          error instanceof FlowError &&
          [400, 404].includes(error.status)
        )
          throw error;
        // Unsupported or unavailable snapshots use the existing live reader.
      }
    }
    readSignal.throwIfAborted();
    if (!this.running) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(readSignal.reason);
        readSignal.addEventListener("abort", abort, { once: true });
        void this.open()
          .then(() => resolve(), reject)
          .finally(() => {
            readSignal.removeEventListener("abort", abort);
          });
      });
    }
    readSignal.throwIfAborted();
    return this.request<
      Omit<CodingHistoryPage, "hasMore"> & { hasMore?: boolean }
    >(
      "coding/history",
      {
        sessionId,
        ...options,
      },
      readSignal,
    );
  }

  selectConversationModel(
    sessionId: string,
    mode: FlowMode,
    selection: ChatModelSelection,
  ) {
    return this.request("coding/model", { sessionId, mode, selection });
  }

  conversations(
    projectId: string,
    includeStatus = true,
  ): Promise<CodingConversation[]> {
    return this.request<CodingConversation[]>("coding/conversations", {
      projectId,
      ...(includeStatus ? {} : { includeStatus: false }),
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
      backendRoots: configuration.backendRoots ?? [],
      plugins: configuration.plugins,
    };
    const candidate = this.createPluginHttp();
    await candidate.replace(next.backendRoots);
    try {
      await this.request(
        "plugins/configure",
        next,
        AbortSignal.timeout(60_000),
      );
    } catch (error) {
      await candidate.close();
      throw error;
    }
    const previous = this.pluginHttpRegistry;
    this.pluginHttpRegistry = candidate;
    this.pluginHttpReady = Promise.resolve();
    await previous.close();
    this.options.flowRoots = configuration.flowRoots.map((root) => ({
      ...root,
      ...(root.plugin ? { plugin: { ...root.plugin } } : {}),
    }));
    this.options.actionRoots = configuration.actionRoots.map((root) => ({
      ...root,
      ...(root.plugin ? { plugin: { ...root.plugin } } : {}),
    }));
    this.options.backendRoots = structuredClone(next.backendRoots);
    this.options.plugins = configuration.plugins.map((plugin) => ({
      ...plugin,
    }));
  }

  async close() {
    this.closed = true;
    this.startupAbort?.abort();
    if (!this.opening) {
      await this.logger.flush();
      return;
    }
    const host = await this.opening.catch(() => undefined);
    if (!host) {
      await this.logger.flush();
      return;
    }
    try {
      await host.rpc.request("shutdown", {}, AbortSignal.timeout(10_000));
    } catch {}
    host.rpc.close();
    host.child.stdin.end();
    const timer = setTimeout(() => host.child.kill(), 3_000);
    await host.exited;
    clearTimeout(timer);
    await this.logger.flush();
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
        "artifactContent" | "uploadImage" | "imageAssetContent" | "pluginHttp"
      >
    >,
) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const plugin = await host.pluginHttp?.(context.req.raw);
    if (plugin) return plugin;
    await next();
  });
  app.use("*", (context, next) =>
    bodyLimit({
      maxSize:
        context.req.method === "POST" && context.req.path === "/assets/images"
          ? 32 * 1024 * 1024
          : 256 * 1024,
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

  app.get("/catalog", async (context) => {
    const body = JSON.stringify(await host.request("catalog"));
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    context.header("ETag", etag);
    context.header("Cache-Control", "private, no-cache");
    if (context.req.header("If-None-Match") === etag)
      return context.body(null, 304);
    return context.body(body, 200, { "Content-Type": "application/json" });
  });
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
