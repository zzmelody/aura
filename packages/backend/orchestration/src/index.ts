import { spawn } from "node:child_process";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dshBin, provisionProfile } from "./profile.ts";
import { FlowError } from "./schema.ts";
import type { FlowRpcResult, HostOptions } from "./types.ts";

/** One lazy long-lived DSH host, independent of browser request lifetimes. */
export class OrchestrationHost {
  options: HostOptions;
  opening: ReturnType<OrchestrationHost["launch"]> | undefined;
  closed = false;
  constructor({ root, dshHome, modelURL, codexModel }: HostOptions) {
    this.options = { root, dshHome, modelURL, codexModel };
    this.opening = undefined;
    this.closed = false;
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
    await provisionProfile(dshHome);
    const child = spawn(process.execPath, [dshBin, "--profile", "aura-flow"], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: "1",
        AURA_FLOW_CWD: root,
        AURA_CODEX_MODEL: codexModel || "gpt-5.6-terra",
        AURA_DEMO_KEY: "demo-only-not-a-real-key",
        AURA_DEMO_BASE_URL: modelURL,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    });
    const rpc = new JsonRpcLineTransport(child.stdout, child.stdin);
    // DSH/provider logs may contain credentials; never forward raw stderr to HTTP or console.
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
        AbortSignal.timeout(30000),
      )) as FlowRpcResult<{ name: string }>;
      if (!result.ok || result.data.name !== "aura-orchestration")
        throw new Error("Invalid host handshake");
      return { child, rpc, exited };
    } catch {
      rpc.close();
      child.kill();
      await exited;
      throw new FlowError(
        "DSH 编排服务启动失败，请检查 preset、依赖和存储配置。",
        503,
      );
    }
  }
  async request<T = unknown>(method: string, params: object = {}): Promise<T> {
    const { rpc } = await this.open();
    let result: FlowRpcResult<T>;
    try {
      result = (await rpc.request(
        method,
        params,
        AbortSignal.timeout(30000),
      )) as FlowRpcResult<T>;
    } catch {
      throw new FlowError(
        "编排连接已中断。运行状态可能已保存，请刷新确认。",
        503,
      );
    }
    if (!result.ok) throw new FlowError(result.message, result.status);
    return result.data;
  }
  async close() {
    this.closed = true;
    if (!this.opening) return;
    const host = await this.opening.catch(() => undefined);
    if (!host) return;
    try {
      await host.rpc.request("shutdown", {}, AbortSignal.timeout(10000));
    } catch {}
    host.rpc.close();
    host.child.stdin.end();
    const timer = setTimeout(() => host.child.kill(), 3000);
    await host.exited;
    clearTimeout(timer);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 256 * 1024) throw new FlowError("流程请求过大。", 413);
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new FlowError("流程请求必须是有效 JSON。");
  }
}

/** Runtime delegates the entire /flows namespace here, after its origin guard. */
export async function handleFlowRequest(
  host: Pick<OrchestrationHost, "request">,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/flows" && !url.pathname.startsWith("/flows/"))
    return false;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  try {
    let data;
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/flows/catalog")
      data = await host.request("catalog");
    else if (req.method === "POST" && url.pathname === "/flows/definitions")
      data = await host.request("save", { definition: await readBody(req) });
    else if (req.method === "GET" && url.pathname === "/flows/runs")
      data = await host.request("list");
    else if (req.method === "POST" && url.pathname === "/flows/runs") {
      const body = await readBody(req);
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new FlowError("无效的流程运行请求。");
      data = await host.request("start", body);
      res.statusCode = 202;
    } else if (
      parts[1] === "runs" &&
      parts.length === 3 &&
      req.method === "GET"
    )
      data = await host.request("get", { id: parts[2] });
    else if (
      parts[1] === "runs" &&
      parts.length === 4 &&
      parts[3] === "cancel" &&
      req.method === "POST"
    )
      data = await host.request("cancel", { id: parts[2] });
    else if (
      parts[1] === "runs" &&
      parts.length === 6 &&
      parts[3] === "steps" &&
      parts[5] === "history" &&
      req.method === "GET"
    ) {
      data = await host.request("history", {
        id: parts[2],
        stepId: parts[4],
        ...(url.searchParams.has("beforeSeq")
          ? { beforeSeq: Number(url.searchParams.get("beforeSeq")) }
          : {}),
      });
    } else throw new FlowError("编排接口不存在。", 404);
    res.end(JSON.stringify(data));
  } catch (error) {
    res.statusCode = error instanceof FlowError ? error.status : 500;
    res.end(
      JSON.stringify({
        message: error instanceof FlowError ? error.message : "编排请求失败。",
      }),
    );
  }
  return true;
}
