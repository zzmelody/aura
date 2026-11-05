import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-sdk-app";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { createWorkspaceService } from "@aura/workspace";
import { createAgentService } from "@aura/agent-runtime";
import { createWorkflowService } from "@aura/orchestration/service";
import { installHostPluginSdkResolutionFromEnv } from "@aura/orchestration/host";
import { FlowError } from "@aura/protocol/errors";
import type { FlowMode } from "@aura/protocol/types";
import { resolveModeDefaults } from "@aura/dsh-auth/model-config";
import { childStartup, type StartupStage } from "./startup-timing.ts";
import { finishDshLoad } from "./host-bootstrap.ts";
import { configureDshNetwork } from "./dsh-network.ts";

export const name = "aura-orchestration";
export const inject = [
  "sessionController",
  "credentials",
  "compaction",
  "tokenMeter",
  "commands",
  "subagents",
  "sessions",
  "agents",
  "permissionPresets",
  "planMode",
  "goals",
  "agentPresets",
  "storageDomain",
  // Coding projects are DSH workspace records; injecting the registry keeps
  // this plugin from starting before its durable domain is initialized.
  "workspaceRegistry",
  "sdkAppStartup",
  "loader",
  "hmr",
  "tools",
  "systemPrompt",
  "skills",
  "llm",
  "settings",
  "subprocess",
  "attachments",
  // Automation tasks are DSH Schedule reminders on coding sessions.
  "schedule",
  "sessionQuery",
  "agentTeams",
];

export async function apply(ctx: Context) {
  finishDshLoad?.();
  const finishSetup = childStartup?.start("orchestration-setup");
  const measure = <T>(stage: StartupStage, work: () => Promise<T>) =>
    childStartup ? childStartup.measure(stage, work) : work();
  // Before any Action, Flow or provider module loads.
  installHostPluginSdkResolutionFromEnv();
  // Electron's bundled Node does not inherit the parent's global dispatcher.
  // Set it inside DSH as well, using only the backend proxy environment.
  configureDshNetwork();
  const modeDefaults = (mode: FlowMode | "configured") =>
    resolveModeDefaults(
      ctx.settings,
      mode,
      process.env.AURA_FLOW_CWD ?? process.cwd(),
      process.env.AURA_CODEX_MODEL,
    );
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

  const flows = await createWorkflowService(ctx, {
    measure,
    resolveModeDefaults: modeDefaults,
  });
  const workspace = createWorkspaceService(ctx);
  await measure("workspace", () => workspace.projects.defaultProject());
  const agent = await createAgentService(ctx, {
    workspaces: workspace.projects,
    images: flows.images,
    tools: flows.tools,
    resolveModeDefaults: modeDefaults,
    measureStorage: (work) => measure("coding-storage", work),
    notify: (method, params) => transport.notify(method, params),
  });

  transport.onNotification(agent.notification);
  transport.onRequest(async (method, params) => {
    try {
      if (exiting) throw new FlowError("编排服务正在关闭，请刷新。", 503);
      if (method === "ping") return { ok: true, data: {} };
      if (method === "initialize") {
        await flows.initialize();
        return { ok: true, data: { name: "aura-orchestration", version: 4 } };
      }
      if (method === "shutdown") {
        await workspace.close();
        await flows.closeExecution();
        setImmediate(() => void disposeAndExit());
        return { ok: true, data: { closed: true } };
      }
      const result =
        (await workspace.request(method, params)) ??
        (await agent.request(method, params));
      const data = result ? result.data : await flows.request(method, params);
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
    finishSetup?.();
    transport.start();
    // The host lives as long as the Aura runtime that spawned it: Flow
    // schedules, chat and the model catalog all need it warm. Parent death
    // closes stdin, which is the only exit path besides an explicit shutdown.
    const disconnected = () => {
      void disposeAndExit().catch(() => process.exit(1));
    };
    process.stdin.on("end", disconnected);
    process.stdin.on("error", disconnected);
    const scan = setInterval(() => {
      flows.refresh();
    }, 5_000);
    return async () => {
      process.stdin.off("end", disconnected);
      process.stdin.off("error", disconnected);
      clearInterval(scan);
      // Cordis disposes this fiber on its own when an injected service is
      // replaced. The transport below is the process's only RPC listener, so
      // a host left running without it is alive but deaf. Exit once cleanup
      // finishes, and let the parent's crash restart bring back a fresh host.
      const unplanned = !exiting;
      exiting = true;
      // A close below can hang (storage already torn down by the same reload),
      // and a hung cleanup must not keep the deaf process alive.
      if (unplanned) setTimeout(() => process.exit(1), 10_000);
      try {
        try {
          await flows.dispose();
        } finally {
          transport.close();
        }
      } finally {
        if (unplanned) process.exit(1);
      }
    };
  }, "aura-orchestration.serve");
}
