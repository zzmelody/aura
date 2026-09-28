import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type {} from "@deepseek-ai/dsh-agent-presets";
import { ActionDiscovery, FlowDiscovery } from "./discovery.ts";
import { FlowEngine } from "./engine.ts";
import { FlowRegistry } from "./registry.ts";
import { actionRunSchema, FlowError, runSchema } from "./schema.ts";
import { dshSessions } from "./sessions.ts";
import type { ContributionRoot, FlowDomain, Table } from "./types.ts";
import type { ActionRun, AuraPluginStatus } from "@aura/protocol/types";
import { ActionRegistry } from "./action-registry.ts";
import { ActionRuntime } from "./actions.ts";
import {
  VEYA_WORLD_AGENT_CAPABILITY,
  VeyaWorldAgentCapability,
} from "./veya-world-agent.ts";
import { AuraCapabilityRouter } from "./capability-router.ts";
import { TripoGameAssetCapability } from "./tripo-game-asset.ts";
import { GeneratedArtifacts } from "./generated-artifacts.ts";
import { WorkflowArtifactIndex } from "./workflow-artifacts.ts";
import { historicalArtifactReader } from "./artifact-history.ts";
import { ActionRuns } from "./action-runs.ts";
import {
  VideoLibrary,
  videoDomainSpec,
  type VideoDocument,
} from "./video-library.ts";
import { videoRequest } from "./video-routes.ts";
import { contentRequest } from "./content-routes.ts";
import { ContentResearch } from "@aura/content-research";
import { TopicLibrary, topicDomainSpec, type TopicState } from "./topic-library.ts";
import { topicRequest } from "./topic-routes.ts";
import { ContentLibrary, contentDomainSpec, type ContentDocument } from "./content-library.ts";
import { LocalAIManager } from "./local-ai/manager.ts";
import { createTripoService, TRIPO_GAME_ASSET_CAPABILITY } from "@aura/tripo";

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
const contributionConfigurationSchema = z
  .object({
    flowRoots: z.array(contributionRootSchema).max(65),
    actionRoots: z.array(contributionRootSchema).max(65),
    plugins: z.array(pluginStatusSchema).max(64),
  })
  .strict();

function rootKey(root: ContributionRoot): string {
  const path = resolve(root.root);
  return JSON.stringify([
    process.platform === "win32" ? path.toLowerCase() : path,
    root.namespace ?? null,
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
    roots.map(({ root }) => realpath(resolve(root)).catch(() => resolve(root))),
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
  "sdkAppStartup",
  "loader",
  "hmr",
  "tools",
  "llm",
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
  const worldAgentSessionPath = process.env.AURA_VEYA_WORLD_AGENT_SESSION_PATH;
  const capabilityRoutes = [];
  const veya = worldAgentSessionPath
    ? new VeyaWorldAgentCapability(worldAgentSessionPath, fetch, {
        artifacts,
        attachments: ctx.attachments,
      })
    : undefined;
  if (veya) capabilityRoutes.push([VEYA_WORLD_AGENT_CAPABILITY, veya] as const);
  const tripoCredentialPath = process.env.AURA_TRIPO_CREDENTIAL_PATH;
  if (tripoCredentialPath) {
    const region = process.env.AURA_TRIPO_REGION;
    if (region !== "global" && region !== "china")
      throw new Error("AURA_TRIPO_REGION must be global or china");
    const tripo = await createTripoService({
      credentialPath: tripoCredentialPath,
      region,
      apiKey: process.env.TRIPO_API_KEY,
    });
    capabilityRoutes.push([
      TRIPO_GAME_ASSET_CAPABILITY,
      new TripoGameAssetCapability(
        tripo,
        artifacts,
        veya ? () => veya.generatedOutputDirectory() : undefined,
        ctx.attachments,
        true,
      ),
    ] as const);
  }
  const auraCapabilities = capabilityRoutes.length
    ? new AuraCapabilityRouter(capabilityRoutes)
    : undefined;
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
  const contentLibrary = new ContentLibrary(contentDomain.table("projects") as unknown as Table<ContentDocument>, artifacts, process.env.AURA_FLOW_CWD ?? process.cwd());
  const research = new ContentResearch(resolve(process.env.DSH_HOME ?? process.env.AURA_FLOW_CWD ?? process.cwd(), "aura-content-research"));
  await research.initialize();
  const topicDomain = await ctx.storageDomain.open(topicDomainSpec);
  const topicLibrary = new TopicLibrary(topicDomain.table("libraries") as unknown as Table<TopicState>, research, artifacts);
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
  );

  const domain = await ctx.storageDomain.open(spec);
  const actionDomain = await ctx.storageDomain.open(actionSpec);
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
  videoLibrary.attach(engine);
  contentLibrary.attach(engine);
  topicLibrary.attach(engine);
  await actionRuns.initialize();
  artifactIndex.attach((id) => engine.get(id), historicalArtifactReader(ctx));

  let activePlugins = pluginStatuses();
  const applyConfiguration = async (
    source: z.infer<typeof contributionConfigurationSchema>,
  ) => {
    const previous = {
      flowRoots: discoveries.descriptors(),
      actionRoots: actionDiscoveries.descriptors(),
      plugins: activePlugins,
    };
    const changedPlugins = changedPluginIds(previous, source);
    try {
      await extendHmrRoots(ctx, [...source.flowRoots, ...source.actionRoots]);
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

  transport.onRequest(async (method, params) => {
    try {
      if (exiting)
        throw new FlowError("编排服务正在回收空闲资源，请刷新。", 503);
      lastActivity = Date.now();
      if (method.startsWith("content-projects/")) return { ok: true, data: await contentRequest(contentLibrary, method.slice("content-projects/".length), params) };
      if (method.startsWith("topic-library/")) return { ok: true, data: await topicRequest(topicLibrary, method.slice("topic-library/".length), params) };
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
        case "history":
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
      await topicDomain.close();
      await research.close();
    };
  }, "aura-orchestration.serve");
}
