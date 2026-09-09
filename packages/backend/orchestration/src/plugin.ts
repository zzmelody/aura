import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type { FlowDomain } from "./types.ts";
import { FlowEngine } from "./engine.ts";
import { FlowError, runSchema, savedSchema } from "./schema.ts";
import { dshSessions } from "./sessions.ts";

export const name = "aura-orchestration";
export const inject = [
  "sessionController",
  "sessions",
  "agents",
  "agentPresets",
  "storageDomain",
  "sdkAppStartup",
  "loader",
];
const spec = defineDomain({
  name: "aura_flows",
  version: 1,
  layout: "per-record",
  tables: {
    definitions: domainTable(savedSchema),
    runs: domainTable(runSchema),
  },
});

export async function apply(ctx: Context) {
  const domain = await ctx.storageDomain.open(spec);
  const engine = new FlowEngine({
    // DSH's generic Domain table projection erases values at this boundary;
    // the concrete zod schemas above validate these persisted record shapes.
    domain: domain as unknown as FlowDomain,
    sessions: dshSessions(ctx),
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
          await ctx.get("loader")?.await();
          data = { name: "aura-orchestration", version: 1 };
          break;
        case "catalog":
          data = await engine.catalog();
          break;
        case "save":
          data = await engine.save(params.definition);
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
        case "cancel":
          data = await engine.cancel(id);
          break;
        case "history":
          if (
            params.beforeSeq !== undefined &&
            typeof params.beforeSeq !== "number"
          )
            throw new FlowError("无效的历史游标。");
          data = await engine.history(id, stepId, params.beforeSeq);
          break;
        case "shutdown":
          await engine.close();
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
            : "DSH 编排服务暂时不可用，请检查后端服务与会话存储。",
      };
    }
  });
  ctx.effect(() => {
    transport.start();
    // Session Controller owns live Agent handles. Recycle its host only when
    // idle, instead of reaching into private handles to tear down sessions.
    const idle = setInterval(() => {
      if (!engine.running.size && Date.now() - lastActivity > 300000)
        void disposeAndExit();
    }, 30000);
    return async () => {
      clearInterval(idle);
      await engine.close();
      transport.close();
      await domain.close();
    };
  }, "aura-orchestration.serve");
}
