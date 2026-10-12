import type {} from "@deepseek-ai/cordis-plugin-loader";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-settings";
import type { AuraCapabilityClient } from "./action-api.ts";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
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
import type { FlowMode } from "@aura/protocol/types";

const chatModeSchema = z.enum(["demo", "codex", "lumina", "custom"]);
import type {
  CapabilityRoot,
  ContributionRoot,
  FlowDomain,
  Table,
} from "./types.ts";
import type { ActionRun, AuraPluginStatus } from "@aura/protocol/types";
import { ActionRegistry } from "./action-registry.ts";
import { ActionRuntime } from "./actions.ts";
import { AuraCapabilityRouter } from "./capability-router.ts";
import { PluginCapabilities } from "./plugin-capabilities.ts";
import { TripoGameAssetCapability } from "./tripo-game-asset.ts";
import { tripoLedgerDirectory } from "./tripo-budget.ts";
import { GeneratedArtifacts } from "./artifacts/generated.ts";
import { WorkflowArtifactIndex } from "./artifacts/workflow-index.ts";
import { historicalArtifactReader } from "./artifacts/history.ts";
import { ActionRuns } from "./action-runs.ts";
import {
  VideoLibrary,
  videoDomainSpec,
  type VideoDocument,
} from "./video/library.ts";
import { videoRequest } from "./video/routes.ts";
import { contentRequest } from "./content/routes.ts";
import { ContentResearch } from "@aura/content-research";
import {
  TopicLibrary,
  topicDomainSpec,
  type TopicState,
} from "./topics/library.ts";
import { topicRequest } from "./topics/routes.ts";
import {
  ContentLibrary,
  contentDomainSpec,
  type ContentDocument,
} from "./content/library.ts";
import {
  ContentAnalyticsLibrary,
  contentAnalyticsDomainSpec,
} from "./content/analytics.ts";
import { contentAnalyticsRequest } from "./content/analytics-routes.ts";
import type {
  ContentExperiment,
  ContentMetricSnapshot,
  ContentPublication,
  ContentReview,
} from "@aura/protocol/content-analytics";
import { LocalAIManager } from "./local-ai/manager.ts";
import { createTripoService, TRIPO_GAME_ASSET_CAPABILITY } from "@aura/tripo";
import { configureDshNetwork } from "./dsh-network.ts";
import { chatService } from "./chat.ts";
import { codingService } from "./coding/session.ts";
import { historyTurns, readSessionEvents } from "./coding/history.ts";
import {
  CodingConversationIndex,
  codingDomainSpec,
  type CodingConversationRecord,
} from "./coding/index-record.ts";
import { CodingProjects } from "./coding/projects.ts";
import { CodingQuestions } from "./coding/questions.ts";
import { chatModelCatalog, RejectedChatModels } from "./chat-models.ts";
import { GptImageService, codexImageRequest } from "./gpt-image.ts";
import {
  codexTokenSource,
  readAiServices,
  customProfiles,
  luminaSettings,
  selectedAgentConfig,
} from "@aura/dsh-auth";
import { agentDefaults } from "./agent-config.ts";

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
    capabilities: z.array(z.string().trim().min(1)).max(32).optional(),
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
const capabilityRootSchema = z
  .object({
    root: z.string().trim().min(1).max(4_096),
    pluginRoot: z.string().min(1).max(4096),
    namespace: z.string().trim().min(1).max(64),
    plugin: pluginIdentitySchema,
    capabilities: z.array(z.string().trim().min(1)).max(32).optional(),
    settings: z.json().optional(),
  })
  .strict();
const contributionConfigurationSchema = z
  .object({
    flowRoots: z.array(contributionRootSchema).max(65),
    actionRoots: z.array(contributionRootSchema).max(65),
    capabilityRoots: z.array(capabilityRootSchema).max(64).default([]),
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
    [...(root.capabilities ?? [])].sort(),
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

export const name = "aura-orchestration";
export const inject = [
  "sessionController",
  "sessions",
  "agents",
  "agentPresets",
  "storageDomain",
  // Coding projects are DSH workspace records; injecting the registry keeps
  // this plugin from starting before its durable domain is initialized.
  "workspaceRegistry",
  "sdkAppStartup",
  "loader",
  "hmr",
  "tools",
  "llm",
  "settings",
  "subprocess",
  "attachments",
];

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

function capabilityRootsFromEnv(): CapabilityRoot[] {
  const value = process.env.AURA_CAPABILITY_ROOTS;
  if (!value) return [];
  return z
    .array(capabilityRootSchema)
    .max(64)
    .parse(JSON.parse(value) as unknown) as CapabilityRoot[];
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

export async function apply(ctx: Context) {
  // Electron's bundled Node does not inherit the parent's global dispatcher.
  // Set it inside DSH as well, using only the backend proxy environment.
  configureDshNetwork();
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
  const localAI = new LocalAIManager(
    ctx.subprocess,
    process.env.AURA_FLOW_CWD ?? process.cwd(),
    { assets: artifacts },
  );
  // This owner survives individual Action Loader/HMR fibers.
  ctx.effect(() => () => localAI.close(), "aura-local-ai.lifecycle");
  const capabilityRoutes: Array<[string, AuraCapabilityClient]> = [];
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
      "local-ai",
      "outputs",
    ),
  });
  const tripoCredentialPath = process.env.AURA_TRIPO_CREDENTIAL_PATH;
  if (tripoCredentialPath) {
    const region = process.env.AURA_TRIPO_REGION;
    if (region !== "global" && region !== "china")
      throw new Error("AURA_TRIPO_REGION must be global or china");
    const tripo = await createTripoService({
      credentialPath: tripoCredentialPath,
      region,
      apiKey: process.env.TRIPO_API_KEY,
      resolveOptions: async () => ({
        credentialPath: tripoCredentialPath,
        region: (
          await readAiServices(
            process.env.AURA_FLOW_CWD ?? process.cwd(),
            codexModel,
            region,
          )
        ).tripoRegion,
        apiKey: process.env.TRIPO_API_KEY,
      }),
    });
    const ledgerDirectory = tripoLedgerDirectory(
      process.env.AURA_FLOW_CWD ?? process.cwd(),
    );
    capabilityRoutes.push([
      TRIPO_GAME_ASSET_CAPABILITY,
      new TripoGameAssetCapability({
        tripo,
        ledgerDirectory,
        artifacts,
        attachments: ctx.attachments,
      }),
    ] as const);
  }
  // Built-in routes plus plugin-contributed providers (`<plugin-id>/<local-id>`).
  const auraCapabilities = new PluginCapabilities({
    builtins: capabilityRoutes.length
      ? new AuraCapabilityRouter(capabilityRoutes)
      : undefined,
    dataRoot: resolve(
      process.env.AURA_FLOW_CWD ?? process.cwd(),
      ".aura",
      "plugins",
    ),
    media: {
      artifacts,
      saveImage: (input) => ctx.attachments.saveImage(input),
    },
    log: (level, message, data) =>
      process.stderr.write(`${JSON.stringify({ level, message, data })}\n`),
  });
  await auraCapabilities.replace(capabilityRootsFromEnv());
  ctx.effect(
    () => () => auraCapabilities.close(),
    "aura-plugin-capabilities.lifecycle",
  );
  const artifactIndex = new WorkflowArtifactIndex(
    artifacts,
    process.env.AURA_FLOW_CWD ?? process.cwd(),
  );
  ctx.effect(() => () => artifactIndex.close(), "aura-artifacts.lifecycle");
  const videoDomain = await ctx.storageDomain.open(videoDomainSpec);
  const videoLibrary = new VideoLibrary(
    videoDomain.table("projects") as unknown as Table<VideoDocument>,
    artifacts,
    process.env.AURA_FLOW_CWD ?? process.cwd(),
  );
  const contentDomain = await ctx.storageDomain.open(contentDomainSpec);
  const contentLibrary = new ContentLibrary(
    contentDomain.table("projects") as unknown as Table<ContentDocument>,
    artifacts,
    process.env.AURA_FLOW_CWD ?? process.cwd(),
  );
  const analyticsDomain = await ctx.storageDomain.open(
    contentAnalyticsDomainSpec,
  );
  const contentAnalytics = new ContentAnalyticsLibrary(
    analyticsDomain.table(
      "publications",
    ) as unknown as Table<ContentPublication>,
    analyticsDomain.table(
      "snapshots",
    ) as unknown as Table<ContentMetricSnapshot>,
    analyticsDomain.table("reviews") as unknown as Table<ContentReview>,
    analyticsDomain.table("experiments") as unknown as Table<ContentExperiment>,
    contentLibrary,
  );
  const research = new ContentResearch(
    resolve(
      process.env.DSH_HOME ?? process.env.AURA_FLOW_CWD ?? process.cwd(),
      "aura-content-research",
    ),
  );
  await research.initialize();
  const topicDomain = await ctx.storageDomain.open(topicDomainSpec);
  const topicLibrary = new TopicLibrary(
    topicDomain.table("libraries") as unknown as Table<TopicState>,
    research,
    artifacts,
  );
  ctx.effect(() => () => research.close(), "aura-research.lifecycle");
  const actionRuntime = new ActionRuntime(
    // Source bodies and credentials stay in backend storage; the domain stores references.
    // Project records have their own domain and outlive run/session history.
    ctx,
    localAI,
    auraCapabilities,
    artifactIndex,
    videoLibrary,
    contentLibrary,
    topicLibrary,
    contentAnalytics,
    gptImage,
  );

  const domain = await ctx.storageDomain.open(spec);
  const actionDomain = await ctx.storageDomain.open(actionSpec);
  // Coding projects ride on DSH's workspace registry; only conversation
  // titles need Aura's own index, since a session header carries none.
  const codingDomain = await ctx.storageDomain.open(codingDomainSpec);
  const codingConversations = new CodingConversationIndex(
    codingDomain.table(
      "conversations",
    ) as unknown as Table<CodingConversationRecord>,
  );
  const codingProjects = new CodingProjects(ctx, codingConversations);
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
  /** Gateway routes are read per request so saved settings apply without a restart. */
  const resolveModeDefaults = async (mode: FlowMode | "configured") => {
    if (mode === "demo") return agentDefaults(mode);
    const document = await readAiServices(
      process.env.AURA_FLOW_CWD ?? process.cwd(),
      process.env.AURA_CODEX_MODEL,
    );
    if (
      mode === "custom" ||
      (mode === "configured" && document.model.mode === "custom")
    ) {
      const route = document.selectedRoute
        ? document.routes[document.selectedRoute]
        : undefined;
      if (!route) throw new FlowError("请先配置自定义模型服务。", 422);
      await ctx.settings.update("llm-pi-ai", {
        providers: customProfiles(document),
      });
      return selectedAgentConfig({ ...document, model: route.settings });
    }
    if (
      mode === "lumina" ||
      (mode === "configured" && document.model.mode === "lumina")
    ) {
      await ctx.settings.update("llm-pi-ai", {
        providers: customProfiles(document),
      });
      return selectedAgentConfig({
        ...document,
        model: luminaSettings(document),
      });
    }
    const codex =
      document.codex ??
      (document.model.mode === "codex" ? document.model : undefined);
    return codex
      ? selectedAgentConfig({ ...document, model: codex })
      : agentDefaults("codex");
  };
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
    onRootSettled: (run) => auraCapabilities.runSettled(run),
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
  auraCapabilities.attachRuns(
    (id) => engine.runs.get(id),
    function* () {
      for (const [, run] of engine.runs.entries()) yield run;
    },
  );
  videoLibrary.attach(engine);
  contentLibrary.attach(engine);
  topicLibrary.attach(engine);
  contentAnalytics.attach(engine);
  await actionRuns.initialize();
  artifactIndex.attach((id) => engine.get(id), historicalArtifactReader(ctx));

  let activePlugins = pluginStatuses();
  let activeCapabilityRoots = capabilityRootsFromEnv();
  const applyConfiguration = async (
    source: z.infer<typeof contributionConfigurationSchema>,
  ) => {
    const previous = {
      flowRoots: discoveries.descriptors(),
      actionRoots: actionDiscoveries.descriptors(),
      capabilityRoots: activeCapabilityRoots,
      plugins: activePlugins,
    };
    const changedPlugins = changedPluginIds(previous, source);
    try {
      await extendHmrRoots(ctx, [...source.flowRoots, ...source.actionRoots]);
      await auraCapabilities.replace(
        source.capabilityRoots as CapabilityRoot[],
      );
      activeCapabilityRoots = source.capabilityRoots as CapabilityRoot[];
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
        await auraCapabilities.replace(previous.capabilityRoots);
        activeCapabilityRoots = previous.capabilityRoots;
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

  let lastActivity = Date.now();
  let exiting = false;
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const disposeAndExit = async () => {
    if (exiting) return;
    exiting = true;
    try {
      await transport.flush();
    } finally {
      await ctx.root.fiber.dispose();
      process.exit(0);
    }
  };

  // Chat tools reach only run admission, video project creation and topic
  // research; streamed deltas travel back as notifications keyed by chatId.
  const chat = chatService(
    ctx,
    {
      start: (input) => engine.start(input),
      get: (id) => engine.get(id),
      async createVideo(name, script) {
        const detail = (await videoRequest(videoLibrary, "create", {
          name,
          script,
        })) as { project: { id: string; revisionId: string } };
        return { id: detail.project.id, revisionId: detail.project.revisionId };
      },
      startVideo: (id, revisionId, requestId) =>
        videoLibrary.start(id, {
          revisionId,
          requestId,
          target: { kind: "project" },
          mode: "reuse",
        }),
      startResearch: (input) =>
        topicLibrary.start(input) as Promise<{ jobId: string; runId: string }>,
    },
    artifacts,
  );
  const chats = new Map<string, AbortController>();
  const rejectedChatModels = new RejectedChatModels();
  const codingAnswers = new CodingQuestions();
  const coding = codingService(ctx, codingAnswers);

  transport.onNotification((method, params) => {
    if (method === "chat/cancel" && typeof params.chatId === "string")
      chats.get(params.chatId)?.abort(new Error("客户端已取消对话。"));
  });

  transport.onRequest(async (method, params) => {
    try {
      if (exiting)
        throw new FlowError("编排服务正在回收空闲资源，请刷新。", 503);
      lastActivity = Date.now();
      if (method.startsWith("content-projects/"))
        return {
          ok: true,
          data: await contentRequest(
            contentLibrary,
            method.slice("content-projects/".length),
            params,
          ),
        };
      if (method.startsWith("content-analytics/"))
        return {
          ok: true,
          data: await contentAnalyticsRequest(
            contentAnalytics,
            method.slice("content-analytics/".length),
            params,
          ),
        };
      if (method.startsWith("topic-library/"))
        return {
          ok: true,
          data: await topicRequest(
            topicLibrary,
            method.slice("topic-library/".length),
            params,
          ),
        };
      if (method.startsWith("video-projects/"))
        return {
          ok: true,
          data: await videoRequest(
            videoLibrary,
            method.slice("video-projects/".length),
            params,
          ),
        };
      const id = typeof params.id === "string" ? params.id : "";
      const stepId = typeof params.stepId === "string" ? params.stepId : "";
      let data;
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
        case "initialize":
          await refreshFlows();
          await ctx.get("loader")?.await();
          await engine.initialize();
          for (const [runId] of engine.runs.entries())
            artifactIndex.enqueue(runId);
          data = { name: "aura-orchestration", version: 4 };
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
          const input = await auraCapabilities
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
          data = (await auraCapabilities.view(engine.get(id))) ?? null;
          break;
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
            await auraCapabilities
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
        case "chat/models": {
          const mode = chatModeSchema.safeParse(params.mode);
          if (!mode.success) throw new FlowError("无效的对话模式。", 400);
          data = await chatModelCatalog(
            ctx.llm,
            mode.data,
            AbortSignal.timeout(15_000),
            rejectedChatModels,
            await resolveModeDefaults(mode.data),
          );
          break;
        }
        case "chat": {
          const chatId = typeof params.chatId === "string" ? params.chatId : "";
          const turn = z
            .object({
              messages: z
                .array(
                  z.object({
                    role: z.enum(["user", "assistant"]),
                    text: z.string().max(80_000),
                    images: z
                      .array(z.string().regex(/^[a-f0-9]{64}$/u))
                      .max(4)
                      .optional(),
                  }),
                )
                .min(1)
                .max(200),
              mode: chatModeSchema,
              model: z.string().trim().min(1).max(200).optional(),
              reasoningEffort: z.string().trim().min(1).max(80).optional(),
            })
            .safeParse(params);
          if (!chatId || chatId.length > 200 || !turn.success)
            throw new FlowError("无效的对话请求。", 400);
          if (chats.size >= 2)
            throw new FlowError("对话服务忙，请稍后再试。", 503);
          const abort = new AbortController();
          chats.set(chatId, abort);
          try {
            data = await chat(
              {
                ...turn.data,
                defaults: await resolveModeDefaults(turn.data.mode),
              },
              (event) => transport.notify("chat/event", { chatId, event }),
              abort.signal,
            );
          } catch (error) {
            // agentFailure names the model when the subscription refuses it.
            const refused =
              error instanceof FlowError
                ? error.message.match(/^模型 (\S+) 不支持 Codex 订阅账号/u)?.[1]
                : undefined;
            if (refused && turn.data.mode === "codex")
              rejectedChatModels.reject("codex", refused);
            throw error;
          } finally {
            chats.delete(chatId);
          }
          break;
        }
        case "coding": {
          const chatId = typeof params.chatId === "string" ? params.chatId : "";
          const turn = z
            .object({
              sessionId: z.string().trim().min(1).max(200),
              projectId: z.string().trim().min(1).max(200),
              prompt: z.string().min(1).max(80_000),
              mode: chatModeSchema,
              model: z.string().trim().min(1).max(200).optional(),
              reasoningEffort: z.string().trim().min(1).max(80).optional(),
            })
            .safeParse(params);
          if (!chatId || chatId.length > 200 || !turn.success)
            throw new FlowError("无效的编码请求。", 400);
          if (chats.size >= 2)
            throw new FlowError("对话服务忙，请稍后再试。", 503);
          // The registry owns the directory, so the sandbox root always comes
          // from the project record rather than a client-supplied path.
          const directory = codingProjects.directory(turn.data.projectId);
          const abort = new AbortController();
          chats.set(chatId, abort);
          try {
            await codingConversations.open(
              turn.data.sessionId,
              turn.data.projectId,
              turn.data.prompt,
            );
            data = await coding.stream(
              {
                ...turn.data,
                project: directory,
                defaults: await resolveModeDefaults(turn.data.mode),
              },
              (event) => transport.notify("chat/event", { chatId, event }),
              abort.signal,
            );
            // Attach only once the session exists: the registry validates a
            // session's stored header, which the first turn just created.
            await codingProjects.attach(
              turn.data.projectId,
              turn.data.sessionId,
            );
          } finally {
            chats.delete(chatId);
          }
          break;
        }
        case "action/start":
          data = await actionRuns.start(params);
          break;
        case "coding/projects":
          data = codingProjects.list();
          break;
        case "coding/projects/create": {
          const input = z
            .object({
              directory: z.string().trim().min(1).max(4096),
              title: z.string().trim().max(100).optional(),
            })
            .safeParse(params);
          if (!input.success) throw new FlowError("无效的项目目录。", 400);
          data = await codingProjects.create(
            input.data.directory,
            input.data.title,
          );
          break;
        }
        case "coding/projects/rename": {
          const input = z
            .object({
              id: z.string().trim().min(1).max(200),
              title: z.string().trim().min(1).max(100),
            })
            .safeParse(params);
          if (!input.success) throw new FlowError("无效的项目名称。", 400);
          data = await codingProjects.rename(input.data.id, input.data.title);
          break;
        }
        case "coding/projects/remove": {
          if (typeof params.id !== "string")
            throw new FlowError("无效的项目。", 400);
          data = await codingProjects.remove(params.id);
          break;
        }
        case "coding/projects/status": {
          if (typeof params.id !== "string")
            throw new FlowError("无效的项目。", 400);
          data = await codingProjects.status(params.id);
          break;
        }
        case "coding/conversations": {
          if (typeof params.projectId !== "string")
            throw new FlowError("无效的项目。", 400);
          data = codingProjects.conversationsOf(params.projectId);
          break;
        }
        case "coding/answer": {
          if (
            typeof params.sessionId !== "string" ||
            typeof params.questionId !== "string"
          )
            throw new FlowError("无效的回答。", 400);
          codingAnswers.answer(
            params.sessionId,
            params.questionId,
            params.answers,
          );
          data = { accepted: true };
          break;
        }
        case "coding/history": {
          if (typeof params.sessionId !== "string")
            throw new FlowError("无效的对话。", 400);
          // Only an indexed conversation is readable, so this cannot open an
          // arbitrary DSH session (a Flow agent's, or another chat's).
          if (!codingConversations.get(params.sessionId))
            throw new FlowError("对话不存在或已移除。", 404);
          const sessionId = SessionId(params.sessionId);
          const events = await readSessionEvents(
            ctx.sessionController,
            sessionId,
            AbortSignal.timeout(30_000),
          );
          const running = coding.running(params.sessionId);
          const turns = historyTurns(events ?? [], running);
          // Questions still waiting carry the ids an answer must quote.
          const open = codingAnswers.open(params.sessionId);
          const last = turns.at(-1);
          if (last && running)
            for (const item of open)
              last.events.push({
                type: "question",
                questionId: item.questionId,
                questions: item.questions,
              });
          data = { turns, running };
          break;
        }
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
        case "shutdown":
          await engine.close();
          await actionRuns.close();
          await localAI.close();
          data = { closed: true };
          setImmediate(() => void disposeAndExit());
          break;
        default:
          throw new FlowError("未知的编排操作。", 404);
      }
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        status: error instanceof FlowError ? error.status : 500,
        message:
          error instanceof FlowError
            ? error.message
            : "DSH 编排服务暂时不可用，请检查后端服务与 Flow 代码。",
      };
    }
  });

  ctx.effect(() => {
    transport.start();
    // Parent death closes stdin. Do not keep model/tool work alive until idle expiry.
    const disconnected = () => {
      void disposeAndExit().catch(() => process.exit(1));
    };
    process.stdin.on("end", disconnected);
    process.stdin.on("error", disconnected);
    const scan = setInterval(
      () => void refreshFlows().catch(() => undefined),
      1_000,
    );
    const idle = setInterval(() => {
      if (
        !engine.running.size &&
        !actionRuns.running.size &&
        !chats.size &&
        Date.now() - lastActivity > 300_000
      )
        void disposeAndExit();
    }, 30_000);
    return async () => {
      process.stdin.off("end", disconnected);
      process.stdin.off("error", disconnected);
      clearInterval(scan);
      clearInterval(idle);
      await engine.close();
      await actionRuns.close();
      await localAI.close();
      await Promise.all([discoveries.close(), actionDiscoveries.close()]);
      transport.close();
      await domain.close();
      await actionDomain.close();
      await videoDomain.close();
      await contentDomain.close();
      await analyticsDomain.close();
      await topicDomain.close();
      await research.close();
    };
  }, "aura-orchestration.serve");
}
