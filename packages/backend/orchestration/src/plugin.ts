import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-agent-presets";
import { ActionDiscovery, FlowDiscovery } from "./discovery.ts";
import { FlowEngine } from "./engine.ts";
import { FlowRegistry } from "./registry.ts";
import { actionRunSchema, FlowError, runSchema } from "./schema.ts";
import { dshSessions } from "./sessions.ts";
import type { FlowDomain, Table } from "./types.ts";
import type { ActionRun } from "@aura/protocol/types";
import { ActionRegistry } from "./action-registry.ts";
import { ActionRuntime } from "./actions.ts";
import { ActionRuns } from "./action-runs.ts";

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
];

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

  const registry = new FlowRegistry();
  ctx.provide("auraFlowRegistry", registry);
  const discovery = new FlowDiscovery(ctx.loader, registry, flowRoot);
  const actionRegistry = new ActionRegistry();
  ctx.provide("auraActionRegistry", actionRegistry);
  const actionDiscovery = new ActionDiscovery(
    ctx.loader,
    actionRegistry,
    actionRoot,
  );
  const actionRuntime = new ActionRuntime(ctx);

  const domain = await ctx.storageDomain.open(spec);
  const actionDomain = await ctx.storageDomain.open(actionSpec);
  const refreshFlows = async () => {
    await Promise.all([discovery.refresh(), actionDiscovery.refresh()]);
  };
  const actionRuns = new ActionRuns({
    table: actionDomain.table("runs") as unknown as Table<ActionRun>,
    registry: actionRegistry,
    runtime: actionRuntime,
    refresh: () => actionDiscovery.refresh(),
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
  await engine.initialize();
  await actionRuns.initialize();

  let lastActivity = Date.now();
  let exiting = false;
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const disposeAndExit = async () => {
    if (exiting) return;
    exiting = true;
    await transport.flush();
    await ctx.root.fiber.dispose();
    process.exit(0);
  };

  transport.onRequest(async (method, params) => {
    try {
      if (exiting)
        throw new FlowError("编排服务正在回收空闲资源，请刷新。", 503);
      lastActivity = Date.now();
      const id = typeof params.id === "string" ? params.id : "";
      const stepId = typeof params.stepId === "string" ? params.stepId : "";
      let data;
      switch (method) {
        case "initialize":
          await refreshFlows();
          await ctx.get("loader")?.await();
          data = { name: "aura-orchestration", version: 3 };
          break;
        case "catalog":
          data = await engine.catalog();
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
        case "start":
          data = await engine.start(params);
          break;
        case "wait":
          data = await engine.wait(id);
          break;
        case "cancel":
          data = await engine.cancel(id);
          break;
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
          data = await engine.history(id, stepId, beforeSeq);
          break;
        case "shutdown":
          await engine.close();
          await actionRuns.close();
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
      clearInterval(scan);
      clearInterval(idle);
      await engine.close();
      await actionRuns.close();
      await discovery.close();
      await actionDiscovery.close();
      transport.close();
      await domain.close();
      await actionDomain.close();
    };
  }, "aura-orchestration.serve");
}
