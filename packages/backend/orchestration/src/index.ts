import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import type { ActionRun, FlowMode, FlowRun } from "@aura/protocol/types";
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
import type { FlowRpcResult, HostOptions } from "./types.ts";

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

  constructor(options: HostOptions) {
    this.options = { ...options };
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
    await provisionProfile(dshHome, flowRoot, actionRoot);
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
          AURA_CODEX_MODEL: codexModel || "gpt-5.6-terra",
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
        result.data.version !== 3
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
        await this.request("cancel", { id: run.id }).catch(() => undefined);
        throw signal.reason;
      }
      throw error;
    }
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
export function createFlowApp(host: Pick<OrchestrationHost, "request">) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 256 * 1_024,
      onError: (context) => context.json({ message: "Flow 请求过大。" }, 413),
    }),
  );

  app.get("/catalog", async (context) =>
    context.json(await host.request("catalog")),
  );
  app.get("/runs", async (context) => context.json(await host.request("list")));
  app.get("/:flowId/source", async (context) =>
    context.json(
      await host.request("source", { id: context.req.param("flowId") }),
    ),
  );
  app.get("/runs/:id", async (context) =>
    context.json(await host.request("get", { id: context.req.param("id") })),
  );
  app.post("/runs/:id/cancel", async (context) =>
    context.json(await host.request("cancel", { id: context.req.param("id") })),
  );
  app.get("/runs/:id/steps/:stepId/history", async (context) => {
    const beforeSeq = context.req.query("beforeSeq");
    return context.json(
      await host.request("history", {
        id: context.req.param("id"),
        stepId: context.req.param("stepId"),
        ...(beforeSeq === undefined ? {} : { beforeSeq: Number(beforeSeq) }),
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
