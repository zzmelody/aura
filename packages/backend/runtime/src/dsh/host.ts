import type {
  CodingSubagent,
  CodingCapabilities,
  CodingCompactionResult,
} from "@aura/protocol/types";
import { PluginHttpRegistry } from "@aura/orchestration/host";
import {
  defaultPluginSdkPackage,
  installHostPluginSdkResolution,
  PLUGIN_SDK_ENV,
} from "@aura/orchestration/host";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StartupTimer } from "./startup-timing.ts";
import {
  catalogLocalization,
  executionPlugins,
} from "../plugin-localization.ts";
import { artifactResponse, type ArtifactFile } from "@aura/orchestration/host";
import { GeneratedArtifacts } from "@aura/orchestration/host";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import type {
  ActionRun,
  AuraPluginStatus,
  CodingProjectInfo,
  ChatModelCatalog,
  ChatModelSelection,
  CodingCollaboration,
  CodingCollaborationAction,
  CodingPermission,
  CodingSteerModelConfig,
  CodingSkillInfo,
  PersonalAssistantInfo,
  FlowMode,
  FlowRun,
  FlowCatalog,
} from "@aura/protocol/types";
import {
  defaultActionRoot,
  defaultFlowRoot,
  dshHostEntry,
  provisionProfile,
} from "./profile.ts";
import {
  CodedFlowError,
  FlowError,
  readErrorDetails,
  type ApiErrorDetails,
} from "@aura/protocol/errors";
import { matchesPluginHttpMount } from "@aura/protocol/plugin-http";
import { reservedPluginHttpMounts } from "../plugin-http-mounts.ts";
import { jsonValue } from "@aura/orchestration/host";
import {
  HostDiagnosticReader,
  HostLogger,
  hostErrorDiagnostic,
  hostErrorDiagnostics,
} from "./host-diagnostics.ts";
export { FlowError } from "@aura/protocol/errors";
import type {
  ChatStreamEvent,
  ChatTurn,
  CodingConversation,
  CodingQuestionAnswer,
  CodingStreamEvent,
  CodingTurn,
} from "@aura/agent-runtime/types";
import type { AutomationHistory, AutomationTask } from "@aura/protocol/types";
import type {
  BackendRoot,
  ContributionConfiguration,
  ContributionRoot,
} from "@aura/orchestration/host";

export interface HostOptions {
  root: string;
  dshHome: string;
  modelURL: string;
  codexModel?: string;
  flowRoot?: string;
  actionRoot?: string;
  flowRoots?: ContributionRoot[];
  actionRoots?: ContributionRoot[];
  backendRoots?: BackendRoot[];
  plugins?: AuraPluginStatus[];
  /** Disposable scratch root. Defaults to `<root>/local/runtime`. */
  tempDir?: string;
  /** Directory for conversations without a project. Defaults to `<root>/.aura/workspace`. */
  defaultWorkspace?: string;
  localIntegrations?: boolean;
  /**
   * Host `@aura/plugin-sdk/package.json`; plugins resolve the SDK from here.
   * Defaults to the SDK this package resolves.
   */
  pluginSdkPackage?: string;
}

type HostRpcResult<T> =
  | { ok: true; data: T }
  | ({ ok: false; status: number; message: string } & Partial<ApiErrorDetails>);

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
    return new PluginHttpRegistry(
      {
        localConfiguration: this.options.localIntegrations === true,
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
      },
      reservedPluginHttpMounts,
    );
  }
  async pluginHttp(request: Request) {
    if (!this.pluginHttpReady) {
      const path = new URL(request.url).pathname;
      const roots = this.options.backendRoots ?? [];
      if (
        !roots.some(({ http }) =>
          http?.mounts.some((mount) => matchesPluginHttpMount(path, mount)),
        )
      )
        return undefined;
      this.pluginHttpReady = this.pluginHttpRegistry.replace(roots);
    }
    await this.pluginHttpReady;
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
        )) as HostRpcResult<unknown>;
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
      throw new CodedFlowError("图片不存在。", 404, {
        code: "image_not_found",
      });
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
    throw new CodedFlowError("图片不存在。", 404, { code: "image_not_found" });
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
    if (this.closed)
      throw new CodedFlowError("编排服务正在关闭。", 503, {
        code: "service_closing",
      });
    if (!this.opening) {
      this.phase = "starting";
      const startup = new StartupTimer(randomUUID(), (timing) =>
        this.logger.writeStartup(timing),
      );
      this.opening = startup
        .measure("total", () => this.launch(startup))
        .catch((error: unknown) => {
          this.opening = undefined;
          this.phase = this.closed ? "stopped" : "unavailable";
          if (!this.closed)
            for (const diagnostic of hostErrorDiagnostics(error))
              this.logger.write("startup-failed", diagnostic);
          throw new CodedFlowError(
            "DSH 编排服务启动失败，请查看 .aura/dsh/logs/aura-host.log。",
            503,
            { code: "service_start_failed" },
          );
        });
    }
    return this.opening;
  }

  async launch(
    startup = new StartupTimer(randomUUID(), (timing) =>
      this.logger.writeStartup(timing),
    ),
  ): Promise<HostProcess> {
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
    await startup.measure("profile", () =>
      provisionProfile(
        dshHome,
        flowRoots.map((entry) => entry.pluginRoot ?? entry.root),
        actionRoots.map((entry) => entry.pluginRoot ?? entry.root),
        root,
        modelURL,
      ),
    );
    if (this.closed)
      throw new CodedFlowError("编排服务正在关闭。", 503, {
        code: "service_closing",
      });
    const spawned = startup.start("process-spawn");
    const child = spawn(
      process.execPath,
      [
        "--expose-internals",
        "--import",
        new URL("./host-bootstrap.ts", import.meta.url).href,
        dshHostEntry,
      ],
      {
        cwd: root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          AURA_DSH_STARTUP_ID: startup.startupId,
          AURA_DSH_STARTUP_ORIGIN: String(startup.origin),
          AURA_FLOW_CWD: root,
          AURA_DEFAULT_WORKSPACE: defaultWorkspace,
          AURA_LOCAL_INTEGRATIONS: this.options.localIntegrations ? "1" : "0",
          AURA_TEMP_DIR: tempDir,
          AURA_FLOW_ROOT: flowRoot,
          AURA_ACTION_ROOT: actionRoot,
          AURA_FLOW_ROOTS: JSON.stringify(flowRoots),
          AURA_ACTION_ROOTS: JSON.stringify(actionRoots),
          AURA_PLUGIN_STATUSES: JSON.stringify(
            executionPlugins(this.options.plugins ?? []),
          ),
          AURA_BACKEND_ROOTS: JSON.stringify(this.options.backendRoots ?? []),
          [PLUGIN_SDK_ENV]: this.options.pluginSdkPackage,
          AURA_CODEX_MODEL: codexModel || "gpt-6.1-sol",
          AURA_DEMO_KEY: "demo-only-not-a-real-key",
          AURA_DEMO_BASE_URL: modelURL,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
      },
    );
    child.once("spawn", () => spawned());
    child.once("error", () => spawned(true));
    const rpc = new JsonRpcLineTransport(child.stdout, child.stdin);
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    const diagnostics = new HostDiagnosticReader(
      (error) => this.logger.write("plugin-error", error),
      () => startupAbort.abort(new Error("Aura plugin did not activate")),
      (timing) => {
        if (timing.startupId === startup.startupId)
          this.logger.writeStartup(timing);
      },
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
      const result = (await startup.measure("handshake", () =>
        rpc.request(
          "initialize",
          {},
          AbortSignal.any([startupAbort.signal, AbortSignal.timeout(120_000)]),
        ),
      )) as HostRpcResult<{ name: string; version: number }>;
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
    let result: HostRpcResult<T>;
    try {
      result = (await rpc.request(method, params, signal)) as HostRpcResult<T>;
    } catch {
      throw new CodedFlowError(
        "编排连接已中断。运行状态可能已保存，请刷新确认。",
        503,
        { code: "connection_interrupted" },
      );
    }
    if (!result.ok) {
      const details = readErrorDetails(result);
      throw details
        ? new CodedFlowError(result.message, result.status, details)
        : new FlowError(result.message, result.status);
    }
    return method === "catalog"
      ? (catalogLocalization(
          result.data as FlowCatalog,
          this.options.plugins ?? [],
        ) as T)
      : result.data;
  }

  async transcribeVoice(id: string, audio: string, signal: AbortSignal) {
    const { rpc } = await this.open();
    signal.throwIfAborted();
    const cancel = () => rpc.notify("integrations/voice/cancel", { id });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await this.request<{ text: string }>(
        "integrations/voice/transcribe",
        { id, audio },
        AbortSignal.any([signal, AbortSignal.timeout(125_000)]),
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
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
  projects(): Promise<CodingProjectInfo[]> {
    return this.request<CodingProjectInfo[]>("coding/projects");
  }

  personalAssistant(create = false): Promise<PersonalAssistantInfo | null> {
    return this.request("coding/assistant", { create });
  }

  skills(projectId: string): Promise<CodingSkillInfo[]> {
    return this.request<CodingSkillInfo[]>("coding/skills", { projectId });
  }

  createProject(directory: string, title?: string): Promise<CodingProjectInfo> {
    return this.request<CodingProjectInfo>("coding/projects/create", {
      directory,
      ...(title ? { title } : {}),
    });
  }

  renameProject(id: string, title: string): Promise<CodingProjectInfo> {
    return this.request<CodingProjectInfo>("coding/projects/rename", {
      id,
      title,
    });
  }

  /** Moves a project to another directory, keeping its title. */
  relocateProject(id: string, directory: string): Promise<CodingProjectInfo> {
    return this.request<CodingProjectInfo>("coding/projects/relocate", {
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

  codingCollaboration(
    sessionId: string,
    action?: CodingCollaborationAction,
    signal?: AbortSignal,
  ) {
    return this.request<CodingCollaboration>(
      "coding/collaboration",
      { sessionId, action },
      signal,
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
    requestId?: string,
  ): Promise<{ steered: boolean }> {
    return this.request<{ steered: boolean }>("coding/steer", {
      sessionId,
      prompt,
      ...(images?.length ? { images } : {}),
      ...(modelConfig ? { modelConfig } : {}),
      ...(requestId ? { requestId } : {}),
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
  ) {
    const { readCodingHistory } = await import("@aura/agent-runtime/history");
    return readCodingHistory(
      {
        dshHome: this.options.dshHome,
        closed: () => this.closed,
        ready: () => this.running !== undefined,
        open: () => this.open(),
        read: (id, historyOptions, readSignal) =>
          this.request(
            "coding/history",
            { sessionId: id, ...historyOptions },
            readSignal,
          ),
      },
      sessionId,
      options,
      signal,
    );
  }

  selectConversationModel(
    sessionId: string,
    mode: FlowMode,
    selection: ChatModelSelection,
  ) {
    return this.request("coding/model", { sessionId, mode, selection });
  }

  /** Saves a conversation's permission preset and applies it to a live agent. */
  selectConversationPermission(
    sessionId: string,
    permission: CodingPermission,
  ) {
    return this.request<{ updated: true }>("coding/permission", {
      sessionId,
      permission,
    });
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
      plugins: executionPlugins(configuration.plugins),
    };
    const candidate = this.createPluginHttp();
    try {
      await candidate.replace(next.backendRoots);
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
