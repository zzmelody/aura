import { PluginPresets } from "./plugin-presets.ts";
import {
  compatibilitySchema,
  httpContributionSchema,
} from "./plugin-compatibility.ts";
import { PluginDomainStorage } from "./plugin-storage.ts";
import type { PluginWorkflows } from "./backend-api.ts";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-settings";
import type { AuraCapabilityClient } from "./action-api.ts";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import type { Context } from "@deepseek-ai/cordis";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { ActionDiscovery, FlowDiscovery } from "./discovery.ts";
import { FlowEngine } from "./engine.ts";
import { FlowRegistry } from "./registry.ts";
import { actionRunSchema, FlowError, runSchema } from "./schema.ts";
import { dshSessions } from "./sessions.ts";
import type {
  BackendRoot,
  ContributionRoot,
  FlowDomain,
  Table,
} from "./types.ts";
import { ActionRegistry } from "./action-registry.ts";
import { ActionRuntime } from "./actions.ts";
import { AuraCapabilityRouter } from "./capability-router.ts";
import { PluginBackends } from "./plugin-backends.ts";
import {
  legacyTripoCapability,
  LEGACY_TRIPO_PERMISSION,
} from "./plugin-capability-compatibility.ts";
import { GeneratedArtifacts } from "./artifacts/generated.ts";
import { WorkflowArtifactIndex } from "./artifacts/workflow-index.ts";
import { historicalArtifactReader } from "./artifacts/history.ts";
import { ActionRuns } from "./action-runs.ts";
import { launchOwned } from "./managed-process/process.ts";
import { acquireProcessLease } from "./managed-process/ownership.ts";
import { chatTools, type ChatToolHost } from "./chat-tools.ts";
import {
  GPT_IMAGE_CAPABILITY,
  GptImageService,
  codexImageRequest,
  gptImageCapability,
} from "./gpt-image.ts";
import { codexTokenSource } from "@aura/dsh-auth";
import type {
  FlowMode,
  FlowRun,
  ActionRun,
  AuraPluginStatus,
  FlowAgentConfig,
} from "@aura/protocol/types";

const pluginIdentitySchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    version: z.string().trim().min(1).max(64),
  })
  .strict();
const contributionRootSchema = z
  .object({
    root: z.string().trim().min(1).max(4_096),
    pluginRoot: z.string().min(1).max(4096).optional(),
    namespace: z.string().trim().min(1).max(64).optional(),
    plugin: pluginIdentitySchema.optional(),
    permissions: z.array(z.string().trim().min(1)).max(32).optional(),
    compatibility: compatibilitySchema.optional(),
    http: httpContributionSchema.optional(),
    presets: z.string().optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.namespace) === Boolean(value.plugin),
    "namespace and plugin metadata must be provided together",
  );
const pluginStatusSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    version: z.string().optional(),
    enabled: z.boolean(),
    available: z.boolean(),
    error: z.string().optional(),
  })
  .strict();
const backendRootSchema = z
  .object({
    root: z.string().trim().min(1).max(4_096),
    pluginRoot: z.string().min(1).max(4096),
    namespace: z.string().trim().min(1).max(64),
    plugin: pluginIdentitySchema,
    permissions: z.array(z.string().trim().min(1)).max(32).optional(),
    compatibility: compatibilitySchema.optional(),
    http: httpContributionSchema.optional(),
    presets: z.string().optional(),
    settings: z.json().optional(),
  })
  .strict();
const contributionConfigurationSchema = z
  .object({
    flowRoots: z.array(contributionRootSchema).max(65),
    actionRoots: z.array(contributionRootSchema).max(65),
    backendRoots: z.array(backendRootSchema).max(64).default([]),
    plugins: z.array(pluginStatusSchema).max(64),
  })
  .strict();

function rootKey(root: ContributionRoot): string {
  const path = resolve(root.root);
  return JSON.stringify([
    process.platform === "win32" ? path.toLowerCase() : path,
    root.namespace ?? null,
    root.pluginRoot ?? null,
    root.plugin ?? null,
    root.compatibility ?? null,
    root.http ?? null,
    root.presets ?? null,
    [...(root.permissions ?? [])].sort(),
  ]);
}

function changedPluginIds(
  previous: {
    flowRoots: ContributionRoot[];
    actionRoots: ContributionRoot[];
  },
  next: {
    flowRoots: ContributionRoot[];
    actionRoots: ContributionRoot[];
  },
): string[] {
  const signatures = (configuration: typeof previous) => {
    const result = new Map<string, string[]>();
    for (const [kind, roots] of [
      ["flow", configuration.flowRoots],
      ["action", configuration.actionRoots],
    ] as const) {
      for (const root of roots) {
        if (!root.plugin) continue;
        const list = result.get(root.plugin.id) ?? [];
        list.push(`${kind}:${rootKey(root)}`);
        result.set(root.plugin.id, list);
      }
    }
    return new Map(
      [...result].map(([id, values]) => [id, values.sort().join("\n")]),
    );
  };
  const before = signatures(previous);
  const after = signatures(next);
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => before.get(id) !== after.get(id),
  );
}

class ContributionDiscoveries {
  readonly #discoveries = new Map<string, FlowDiscovery | ActionDiscovery>();
  readonly #create: (root: ContributionRoot) => FlowDiscovery | ActionDiscovery;

  constructor(
    roots: ContributionRoot[],
    create: (root: ContributionRoot) => FlowDiscovery | ActionDiscovery,
  ) {
    this.#create = create;
    for (const root of roots) this.add(root);
  }

  private add(root: ContributionRoot) {
    const key = rootKey(root);
    if (this.#discoveries.has(key))
      throw new FlowError("插件贡献目录重复。", 400);
    this.#discoveries.set(key, this.#create(root));
  }

  descriptors(): ContributionRoot[] {
    return [...this.#discoveries.values()].map((item) => item.descriptor());
  }

  async refresh(): Promise<void> {
    await Promise.all(
      [...this.#discoveries.values()].map((item) => item.refresh()),
    );
  }

  hasUnavailableContributions(): boolean {
    return [...this.#discoveries.values()].some((item) =>
      item.hasUnavailableContributions(),
    );
  }

  async replace(roots: ContributionRoot[]): Promise<void> {
    const next = new Map<string, ContributionRoot>();
    for (const root of roots) {
      const key = rootKey(root);
      if (next.has(key)) throw new FlowError("插件贡献目录重复。", 400);
      next.set(key, root);
    }
    for (const [key, discovery] of [...this.#discoveries]) {
      if (next.has(key)) continue;
      await discovery.close();
      this.#discoveries.delete(key);
    }
    for (const [key, root] of next) {
      if (this.#discoveries.has(key)) continue;
      const discovery = this.#create(root);
      this.#discoveries.set(key, discovery);
      await discovery.refresh();
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#discoveries.values()].map((item) => item.close()),
    );
    this.#discoveries.clear();
  }
}

async function extendHmrRoots(ctx: Context, roots: ContributionRoot[]) {
  const paths = await Promise.all(
    roots.map(({ root, pluginRoot }) =>
      realpath(resolve(pluginRoot ?? root)).catch(() =>
        resolve(pluginRoot ?? root),
      ),
    ),
  );
  type DynamicHmr = {
    config: { root: string[] };
    watcher?: { add(paths: string[]): unknown };
  };
  const hmr = (ctx as Context & { hmr: DynamicHmr }).hmr;
  if (!hmr.watcher)
    throw new FlowError("插件热加载服务尚未就绪，请稍后重试。", 503);
  const normalize = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  const watched = new Set(hmr.config.root.map(normalize));
  const added = paths.filter((path) => !watched.has(normalize(path)));
  if (!added.length) return;
  hmr.config.root.push(...added);
  hmr.watcher.add(added);
}

function contributionRoots(
  name: "AURA_FLOW_ROOTS" | "AURA_ACTION_ROOTS",
  legacy: string,
): ContributionRoot[] {
  const value = process.env[name];
  if (!value) return [{ root: legacy }];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${name} must be an array`);
  return parsed.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { root?: unknown }).root !== "string"
    )
      throw new Error(`${name} contains an invalid root`);
    return item as ContributionRoot;
  });
}

function backendRootsFromEnv(): BackendRoot[] {
  const value = process.env.AURA_BACKEND_ROOTS;
  if (!value) return [];
  return z
    .array(backendRootSchema)
    .max(64)
    .parse(JSON.parse(value) as unknown) as BackendRoot[];
}

function pluginStatuses(): AuraPluginStatus[] {
  const value = process.env.AURA_PLUGIN_STATUSES;
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("AURA_PLUGIN_STATUSES must be an array");
  return parsed as AuraPluginStatus[];
}

const spec = defineDomain({
  name: "aura_code_flows",
  version: 1,
  layout: "per-record",
  tables: { runs: domainTable(runSchema) },
});
const actionSpec = defineDomain({
  name: "aura_code_actions",
  version: 1,
  layout: "per-record",
  tables: { runs: domainTable(actionRunSchema) },
});

type WorkflowStartupStage =
  | "plugin-presets"
  | "plugin-backends"
  | "flow-storage"
  | "action-storage"
  | "action-recovery"
  | "discovery"
  | "loader-settle"
  | "flow-recovery";

interface WorkflowServiceOptions {
  measure<T>(stage: WorkflowStartupStage, work: () => Promise<T>): Promise<T>;
  resolveModeDefaults(mode: FlowMode | "configured"): Promise<FlowAgentConfig>;
}

export async function createWorkflowService(
  ctx: Context,
  options: WorkflowServiceOptions,
) {
  const { measure, resolveModeDefaults } = options;
  const flowRoot = process.env.AURA_FLOW_ROOT;
  if (!flowRoot) throw new Error("AURA_FLOW_ROOT is required");
  const actionRoot = process.env.AURA_ACTION_ROOT;
  if (!actionRoot) throw new Error("AURA_ACTION_ROOT is required");
  const flowRoots = contributionRoots("AURA_FLOW_ROOTS", flowRoot);
  const actionRoots = contributionRoots("AURA_ACTION_ROOTS", actionRoot);

  const registry = new FlowRegistry();
  ctx.provide("auraFlowRegistry", registry);
  const discoveries = new ContributionDiscoveries(
    flowRoots,
    (root) => new FlowDiscovery(ctx.loader, registry, root),
  );
  const actionRegistry = new ActionRegistry();
  ctx.provide("auraActionRegistry", actionRegistry);
  const actionDiscoveries = new ContributionDiscoveries(
    actionRoots,
    (root) => new ActionDiscovery(ctx.loader, actionRegistry, root),
  );
  const artifacts = new GeneratedArtifacts(
    resolve(
      process.env.DSH_HOME ?? process.env.AURA_FLOW_CWD ?? process.cwd(),
      "aura-generated-assets",
    ),
  );
  // GPT images use the signed-in Codex subscription, the same login as chat.
  const codexModel = process.env.AURA_CODEX_MODEL || "gpt-6.1-sol";
  const codexTokens = codexTokenSource(ctx, codexModel);
  const gptImage = new GptImageService({
    request: codexImageRequest(codexTokens, codexModel),
    signedIn: () => codexTokens.signedIn(),
    artifacts,
    outputRoot: resolve(
      process.env.AURA_FLOW_CWD ?? process.cwd(),
      ".aura",
      "codex-image",
      "outputs",
    ),
  });
  const capabilityRoutes: Array<[string, AuraCapabilityClient]> = [
    [GPT_IMAGE_CAPABILITY, gptImageCapability(gptImage)],
    [LEGACY_TRIPO_PERMISSION, legacyTripoCapability(() => pluginBackends)],
  ];
  // Built-in host capabilities, granted to Actions and backends by `permissions`.
  const builtins = new AuraCapabilityRouter(capabilityRoutes);
  // One backend per plugin.
  const workflowPort: { current?: PluginWorkflows } = {};
  const pluginBackends = new PluginBackends({
    host: {
      cwd: process.env.AURA_FLOW_CWD ?? process.cwd(),
      localConfiguration: process.env.AURA_LOCAL_INTEGRATIONS === "1",
      storage: new PluginDomainStorage(
        ctx.storageDomain,
        process.env.DSH_HOME ?? process.env.AURA_FLOW_CWD ?? process.cwd(),
      ),
      artifacts,
      workflows: {
        start: (input) => {
          if (!workflowPort.current)
            throw new Error("plugin_workflows_not_ready");
          return workflowPort.current.start(input);
        },
        get: (id) => {
          if (!workflowPort.current)
            throw new Error("plugin_workflows_not_ready");
          return workflowPort.current.get(id);
        },
        runs: {
          entries: function* () {
            if (workflowPort.current)
              yield* workflowPort.current.runs.entries();
          },
        },
      },
    },
    builtins,
    dataRoot: resolve(
      process.env.AURA_FLOW_CWD ?? process.cwd(),
      ".aura",
      "plugins",
    ),
    tempRoot: resolve(
      process.env.AURA_TEMP_DIR ??
        resolve(process.env.AURA_FLOW_CWD ?? process.cwd(), "local", "runtime"),
      "plugins",
    ),
    processes: {
      launch: (spec) => launchOwned(ctx.subprocess, spec),
      acquireLease: acquireProcessLease,
    },
    media: {
      artifacts,
      saveImage: (input) => ctx.attachments.saveImage(input),
      readImage: async (reference, signal) =>
        (
          await ctx.attachments.readImage(
            reference as Parameters<Context["attachments"]["readImage"]>[0],
            signal,
          )
        ).data,
    },
    log: (level, message, data) =>
      process.stderr.write(`${JSON.stringify({ level, message, data })}\n`),
  });
  const pluginPresets = new PluginPresets(ctx.agentPresets);
  await measure("plugin-presets", () =>
    pluginPresets.replace(backendRootsFromEnv()),
  );
  ctx.effect(
    () => () => pluginPresets.close(),
    "aura-plugin-presets.lifecycle",
  );
  await measure("plugin-backends", () =>
    pluginBackends.replace(backendRootsFromEnv()),
  );
  actionRegistry.setServicesResolver((id) => pluginBackends.services(id));
  actionRegistry.setServiceRetention((id) =>
    pluginBackends.serviceRetention(id),
  );
  ctx.effect(
    () => () => pluginBackends.close(),
    "aura-plugin-backends.lifecycle",
  );
  const artifactIndex = new WorkflowArtifactIndex(
    artifacts,
    process.env.AURA_FLOW_CWD ?? process.cwd(),
  );
  artifactIndex.setPluginCandidates((output, producer) =>
    pluginBackends.artifactCandidates(output, producer),
  );
  ctx.effect(() => () => artifactIndex.close(), "aura-artifacts.lifecycle");
  const actionRuntime = new ActionRuntime(ctx, builtins, artifactIndex);

  const domain = await measure("flow-storage", () =>
    ctx.storageDomain.open(spec),
  );
  const actionDomain = await measure("action-storage", () =>
    ctx.storageDomain.open(actionSpec),
  );
  let reconfiguration: Promise<unknown> = Promise.resolve();
  const refreshFlows = async () => {
    await reconfiguration;
    await Promise.all([discoveries.refresh(), actionDiscoveries.refresh()]);
  };
  const refreshActions = async () => {
    await reconfiguration;
    await actionDiscoveries.refresh();
  };
  const actionRuns = new ActionRuns({
    table: actionDomain.table("runs") as unknown as Table<ActionRun>,
    registry: actionRegistry,
    runtime: actionRuntime,
    refresh: refreshActions,
    cwd: process.env.AURA_FLOW_CWD ?? process.cwd(),
  });
  const engine = new FlowEngine({
    resolveAgentDefaults: resolveModeDefaults,
    // DSH's generic Domain table projection erases values at this boundary;
    // the concrete zod schema above validates persisted records.
    domain: domain as unknown as FlowDomain,
    sessions: dshSessions(ctx, actionRuntime),
    registry,
    refreshFlows,
    actions: {
      registry: actionRegistry,
      runtime: actionRuntime,
      cwd: process.env.AURA_FLOW_CWD ?? process.cwd(),
    },
    plugins: pluginStatuses(),
    onRootSettled: async (run) => {
      const notifyActionProviders = async (settled: FlowRun) => {
        await pluginBackends.actionRunSettled(settled);
        for (const step of settled.steps) {
          if (step.kind !== "flow" || !step.childRunId) continue;
          const child = engine.runs.get(step.childRunId);
          if (child) await notifyActionProviders(child);
        }
      };
      await notifyActionProviders(run);
      await pluginBackends.runSettled(run);
    },
    presets: async () =>
      (await ctx.agentPresets.list()).map(
        ({ id, name, description, broken }) => ({
          id,
          name: name ?? id,
          description: description ?? "",
          unavailable: Boolean(broken),
        }),
      ),
  });
  pluginBackends.attachRuns(
    (id) => engine.runs.get(id),
    function* () {
      for (const [, run] of engine.runs.entries()) yield run;
    },
  );
  workflowPort.current = engine;
  await measure("action-recovery", () => actionRuns.initialize());
  artifactIndex.attach((id) => engine.get(id), historicalArtifactReader(ctx));

  let activePlugins = pluginStatuses();
  let activeBackendRoots = backendRootsFromEnv();
  const applyConfiguration = async (
    source: z.infer<typeof contributionConfigurationSchema>,
  ) => {
    const previous = {
      flowRoots: discoveries.descriptors(),
      actionRoots: actionDiscoveries.descriptors(),
      backendRoots: activeBackendRoots,
      plugins: activePlugins,
    };
    const changedPlugins = changedPluginIds(previous, source);
    try {
      await extendHmrRoots(ctx, [...source.flowRoots, ...source.actionRoots]);
      await pluginPresets.replace(source.backendRoots as BackendRoot[]);
      await pluginBackends.replace(source.backendRoots as BackendRoot[]);
      activeBackendRoots = source.backendRoots as BackendRoot[];
      await discoveries.replace(source.flowRoots);
      await actionDiscoveries.replace(source.actionRoots);
      await ctx.loader.await();
      await Promise.all([discoveries.refresh(), actionDiscoveries.refresh()]);
      if (
        discoveries.hasUnavailableContributions() ||
        actionDiscoveries.hasUnavailableContributions()
      )
        throw new FlowError("插件贡献加载失败，当前运行配置保持不变。", 422);
      activePlugins = source.plugins;
      engine.setPlugins(activePlugins, changedPlugins);
    } catch (error) {
      try {
        await pluginPresets.replace(previous.backendRoots);
        await pluginBackends.replace(previous.backendRoots);
        activeBackendRoots = previous.backendRoots;
        await discoveries.replace(previous.flowRoots);
        await actionDiscoveries.replace(previous.actionRoots);
        await ctx.loader.await();
        await Promise.all([discoveries.refresh(), actionDiscoveries.refresh()]);
        activePlugins = previous.plugins;
        engine.setPlugins(activePlugins);
      } catch {
        throw new FlowError(
          "插件贡献加载失败，且运行时回滚失败；请重新保存当前配置。",
          503,
        );
      }
      throw error instanceof FlowError
        ? error
        : new FlowError("插件贡献加载失败，当前运行配置保持不变。", 422);
    }
  };
  const configure = (source: unknown) => {
    const parsed = contributionConfigurationSchema.safeParse(source);
    if (!parsed.success)
      throw new FlowError("插件运行配置不符合 Aura 规则。", 400);
    const task = reconfiguration.then(() => applyConfiguration(parsed.data));
    reconfiguration = task.catch(() => undefined);
    return task;
  };

  // Conversation tools use generic workflow admission and plugin contributions.
  const workflowTools: ChatToolHost = {
    start: ({ conversationId, ...input }) =>
      engine.start(input, conversationId),
    get: (id) => engine.get(id),
    storageIssue: (id) => engine.storageIssue(id),
    catalog: () => engine.catalog(),
    associateConversation: (id, conversationId) =>
      engine.associateConversation(id, conversationId),
    taskTools: () => pluginBackends.taskTools(),
  };
  return {
    images: artifacts,
    tools: (scope: Parameters<typeof chatTools>[1]) =>
      chatTools(workflowTools, scope),
    request,
    async initialize() {
      await measure("discovery", refreshFlows);
      await measure("loader-settle", async () => {
        await ctx.get("loader")?.await();
      });
      await measure("flow-recovery", () =>
        engine.initialize({ discovered: true }),
      );
      for (const [runId] of engine.runs.entries()) artifactIndex.enqueue(runId);
    },
    refresh() {
      void refreshFlows().catch(() => undefined);
      void pluginBackends.refresh().catch(() => undefined);
    },
    closeExecution,
    async dispose() {
      await closeExecution();
      await Promise.all([discoveries.close(), actionDiscoveries.close()]);
      await domain.close();
      await actionDomain.close();
    },
  };

  async function closeExecution() {
    await engine.close();
    await actionRuns.close();
  }

  async function request(method: string, params: Record<string, unknown>) {
    const id = typeof params.id === "string" ? params.id : "";
    const stepId = typeof params.stepId === "string" ? params.stepId : "";
    let data: unknown;
    switch (method) {
      case "ai-services/busy":
        // Match terminal task states; a crashed Run must not lock settings forever.
        data = [...engine.runs.entries()].some(
          ([, run]) =>
            !["completed", "failed", "cancelled", "interrupted"].includes(
              run.status,
            ),
        );
        break;
      case "catalog":
        data = await engine.catalog();
        break;
      case "plugins/configure":
        await configure(params);
        data = { applied: true };
        break;
      case "source":
        await refreshFlows();
        data = registry.source(id);
        break;
      case "list":
        data = engine.list();
        break;
      case "get":
        data = engine.get(id);
        break;
      case "artifacts/list":
        data = await artifactIndex.list(id, params.retry === true);
        break;
      case "artifacts/resolve":
        data = await artifactIndex.resolve(
          id,
          typeof params.artifactId === "string" ? params.artifactId : "",
          params.thumbnail === true,
        );
        break;
      case "start":
        data = await engine.start(params);
        break;
      case "services/start": {
        // Admission belongs to the Flow's plugin and runs on every POST, so a
        // repeated request can refresh client state (for example a replaced
        // session descriptor). An existing Run is returned, never restarted.
        const request = z
          .object({
            requestId: z.uuid(),
            flowId: z.string().min(1).max(130),
            input: z.json(),
          })
          .strict()
          .parse(params);
        const existing = [...engine.runs.entries()].find(
          ([, run]) => run.requestId === request.requestId && !run.parent,
        )?.[1];
        if (existing && existing.flow.id !== request.flowId)
          throw new FlowError("同一请求 ID 不能用于不同 Flow。", 409);
        const input = await pluginBackends
          .admit(
            request.flowId,
            request.requestId,
            request.input,
            AbortSignal.timeout(60_000),
          )
          .catch((error: unknown) => {
            // Only a bounded snake_case code crosses to the client; never free text or paths.
            const code = /^[a-z][a-z0-9_]{2,63}$/u.exec(
              String((error as Error)?.message ?? ""),
            )?.[0];
            throw new FlowError(code ?? "admission_failed", 422);
          });
        data =
          existing ??
          (await engine.start({
            requestId: request.requestId,
            flowId: request.flowId,
            serviceOnly: true,
            useConfiguredModel: true,
            mode: "codex",
            input,
          }));
        break;
      }
      case "services/find": {
        // Clients address service Runs by their own idempotency key, never by internal Run IDs.
        const requestId = z.uuid().parse(params.requestId);
        const found = [...engine.runs.entries()].find(
          ([, run]) => run.requestId === requestId && !run.parent,
        )?.[1];
        if (!found) throw new FlowError("Flow 运行不存在。", 404);
        data = found;
        break;
      }
      case "services/view":
        data = (await pluginBackends.view(engine.get(id))) ?? null;
        break;
      case "plugins/page-invoke": {
        // Controlled page boundary: a plugin page reaches only its own
        // backend's declared page operations. Failures cross as codes.
        const request = z
          .object({
            pluginId: z.string().min(1).max(64),
            operation: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
            input: z.json(),
          })
          .strict()
          .parse(params);
        data = await pluginBackends
          .invokeFromPage(
            request.pluginId,
            request.operation,
            request.input,
            AbortSignal.timeout(120_000),
          )
          .catch((error: unknown) => {
            const code = /^[a-z][a-z0-9_]{2,63}$/u.exec(
              String((error as Error)?.message ?? ""),
            )?.[0];
            throw new FlowError(
              code ?? "page_operation_failed",
              code?.endsWith("_forbidden") ? 403 : 422,
            );
          });
        break;
      }
      case "services/resume": {
        const request = z
          .object({
            id: z.uuid(),
            requestId: z.uuid(),
            input: z.json().optional(),
          })
          .strict()
          .parse(params);
        if (request.input !== undefined)
          await pluginBackends
            .resume(
              engine.get(request.id),
              request.input,
              AbortSignal.timeout(60_000),
            )
            .catch((error: unknown) => {
              const code = /^[a-z][a-z0-9_]{2,63}$/u.exec(
                String((error as Error)?.message ?? ""),
              )?.[0];
              throw new FlowError(code ?? "resume_refused", 422);
            });
        // Re-admitted input applies to the Run in any state; only a paused Run is resumed.
        data =
          engine.get(request.id).status === "paused"
            ? await engine.command(request.id, "resume", {
                requestId: request.requestId,
              })
            : engine.get(request.id);
        break;
      }
      case "wait":
        data = await engine.wait(id);
        break;
      case "cancel":
      case "pause":
      case "resume":
      case "answer":
      case "resolve": {
        const { id: _id, stepKey: key, ...body } = params;
        data = await engine.command(
          id,
          method,
          body,
          typeof key === "string" ? key : undefined,
        );
        break;
      }
      case "action/start":
        data = await actionRuns.start(params);
        break;
      case "action/get":
        data = actionRuns.get(id);
        break;
      case "action/wait":
        data = await actionRuns.wait(id);
        break;
      case "action/cancel":
        data = await actionRuns.cancel(id);
        break;
      case "history": {
        const beforeSeq = params.beforeSeq;
        if (
          beforeSeq !== undefined &&
          (typeof beforeSeq !== "number" ||
            !Number.isSafeInteger(beforeSeq) ||
            beforeSeq < 0)
        )
          throw new FlowError("无效的历史游标。");
        const attempt = params.attempt;
        if (
          attempt !== undefined &&
          (typeof attempt !== "number" ||
            !Number.isSafeInteger(attempt) ||
            attempt < 1)
        )
          throw new FlowError("无效的 attempt。");
        data = await engine.history(id, stepId, beforeSeq, attempt);
        break;
      }
      default:
        data = await pluginBackends
          .request(method, params, AbortSignal.timeout(120_000))
          .catch((error) => {
            if (
              error instanceof Error &&
              error.message === "plugin_request_unavailable"
            )
              throw new FlowError("未知的编排操作。", 404);
            throw error;
          });
        break;
    }
    return data;
  }
}
