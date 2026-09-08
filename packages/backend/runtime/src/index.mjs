/** Aura backend runtime shared by standalone and desktop application outputs. */
import { createServer } from "node:http";
import { mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { DshCodexAuthorization } from "@aura/dsh-codex";
import { streamDemo } from "@aura/demo";
import { validateMessages } from "@aura/protocol";
import { readJson } from "./validation.mjs";

const defaultRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** @param {import('node:http').Server} server */
async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose) => {
    server.close(() => resolveClose(undefined));
    server.closeAllConnections();
  });
}

/**
 * Starts one Aura HTTP/DSH runtime instance.
 * @param {{ root?: string, host?: string, port?: number }} [options]
 */
export async function startAuraRuntime(options = {}) {
  const root = options.root ?? defaultRoot;
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT ?? 4311);
  const dshHome = join(root, ".aura", "dsh");
  const codex = await DshCodexAuthorization.create({
    credentialPath: join(dshHome, ".credentials.yaml"),
    model: process.env.AURA_CODEX_MODEL,
  });
  const profileDir = join(dshHome, "profiles", "aura-sdk");
  await mkdir(profileDir, { recursive: true });
  for (const name of ["package.json", "cordis.patch.yml"])
    await copyFile(
      new URL(`../profile/${name}`, import.meta.url),
      join(profileDir, name),
    );
  const require = createRequire(import.meta.url);
  const dshBin = join(
    dirname(require.resolve("@deepseek-ai/dsh/package.json")),
    "lib",
    "bin.js",
  );
  const children = new Set();
  let shuttingDown = false;
  let admittedRequests = 0;

  // The fake model endpoint is separate and always loopback-only. No API key is read.
  const model = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const request = await readJson(req);
      const marker = "AURA_HISTORY_V1\n";
      const input = request.messages
        ?.filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                ?.filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        )
        .findLast((text) => text?.startsWith(marker));
      if (!input) throw new Error("Missing Aura history payload");
      const { messages } = JSON.parse(input.slice(marker.length));
      if (!validateMessages(messages)) throw new Error("Invalid demo history");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      for await (const text of streamDemo(messages, {
        signal: abort.signal,
        delay: 8,
      })) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
        );
      }
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      if (!res.destroyed) console.error("[fake model]", error.message);
      if (!res.headersSent) res.writeHead(400);
      if (!res.destroyed) res.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", () => resolveListen(undefined));
  });
  const modelAddress = model.address();
  if (modelAddress === null || typeof modelAddress === "string") {
    await codex.close();
    throw new Error("Aura demo model did not expose a TCP port.");
  }
  const modelURL = `http://127.0.0.1:${modelAddress.port}/v1`;

  /** One isolated DSH process per request: client history is explicit input. */
  async function runDsh(messages, res, route) {
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error("DSH 响应超时。")),
      60000,
    );
    const onClose = () => {
      if (!res.writableEnded) abort.abort(new Error("连接已关闭。"));
    };
    res.on("close", onClose);
    const child = spawn(process.execPath, [dshBin, "--profile", "aura-sdk"], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: "1",
        AURA_DEMO_KEY: "demo-only-not-a-real-key",
        AURA_DEMO_BASE_URL: modelURL,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-6000);
    });
    const rpc = new JsonRpcLineTransport(child.stdout, child.stdin);
    const sessionId = randomUUID();
    let ended = false;
    let textSeen = false;
    let settle;
    const completed = new Promise((resolveTurn, rejectTurn) => {
      settle = { resolve: resolveTurn, reject: rejectTurn };
    });
    completed.catch(() => {});
    child.once("error", (error) => settle.reject(error));
    child.once("exit", () => {
      if (!ended) settle.reject(new Error(`DSH exited early. ${stderr}`));
    });
    const onAbort = () => {
      settle.reject(abort.signal.reason);
      child.kill();
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    rpc.onNotification((method, params) => {
      if (method !== "session.event" || params.sessionId !== sessionId) return;
      const event = params.event;
      if (
        event.type === "assistant/chunk" &&
        event.data.chunk.type === "text-delta"
      ) {
        textSeen = true;
        if (!res.destroyed)
          res.write(
            JSON.stringify({ type: "delta", text: event.data.chunk.text }) + "\n",
          );
      }
      if (event.type === "turn/end") {
        ended = true;
        if (event.data.reason.kind === "completed" && textSeen) settle.resolve();
        else
          settle.reject(
            new Error(`DSH turn ended: ${JSON.stringify(event.data.reason)}`),
          );
      }
    });
    rpc.start();
    try {
      const info = await rpc.request(
        "initialize",
        {
          cwd: root,
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          maxTokens: route.maxTokens,
        },
        abort.signal,
      );
      if (info.serverInfo?.name !== "deepseek-harness-sdk-runtime")
        throw new Error("DSH handshake failed");
      await rpc.request(
        "session/prompt",
        {
          sessionId,
          contentBlocks: [
            {
              type: "text",
              text: "AURA_HISTORY_V1\n" + JSON.stringify({ messages }),
            },
          ],
        },
        abort.signal,
      );
      await completed;
      await rpc.request("shutdown", {}, abort.signal);
      if (!res.destroyed)
        res.end(
          JSON.stringify({
            type: "done",
            engine: "deepseek-harness",
            mode: route.mode,
            ...(route.mode === "codex-subscription" ? { model: route.model } : {}),
          }) + "\n",
        );
    } catch (error) {
      console.error("[DSH runtime]", error.message);
      if (!res.destroyed)
        res.end(
          JSON.stringify({
            type: "error",
            message: "DSH 请求暂时不可用，请检查服务终端和登录状态后重试。",
          }) + "\n",
        );
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
      abort.signal.removeEventListener("abort", onAbort);
      rpc.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await exited;
      children.delete(child);
    }
  }

  /** Allows native clients, loopback pages and same-host LAN development pages. */
  function allowOrigin(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const originHost = new URL(origin).hostname;
      const requestHost = new URL(`http://${req.headers.host}`).hostname;
      const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
      if (
        originHost !== requestHost &&
        !(loopback.has(originHost) && loopback.has(requestHost))
      )
        return false;
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      return true;
    } catch {
      return false;
    }
  }

  const api = createServer(async (req, res) => {
    if (!allowOrigin(req, res)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          service: "aura-runtime",
          modes: ["dsh-demo", "codex-subscription"],
          keyRequired: false,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/auth/codex/status") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(await codex.status()));
      return;
    }
    if (req.method === "POST" && req.url === "/auth/codex/start") {
      try {
        const body = await readJson(req, 4096);
        if (body.method !== "browser" && body.method !== "device_code")
          throw new Error("Invalid login method");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(await codex.startLogin(body.method)));
      } catch {
        if (!res.headersSent) res.writeHead(400);
        if (!res.destroyed)
          res.end(JSON.stringify({ message: "无法开始 Codex 登录。" }));
      }
      return;
    }

    const isDshChat = req.method === "POST" && req.url === "/chat";
    const isCodexChat = req.method === "POST" && req.url === "/chat/codex";
    if (!isDshChat && !isCodexChat) {
      res.writeHead(404).end();
      return;
    }
    if (shuttingDown || admittedRequests >= 2) {
      res.writeHead(503).end("服务忙，请稍后再试。");
      return;
    }
    admittedRequests++;
    try {
      const body = await readJson(req);
      if (!validateMessages(body.messages)) throw new Error("Invalid messages");
      if (
        typeof body.sessionId !== "string" ||
        body.sessionId.length < 1 ||
        body.sessionId.length > 200
      )
        throw new Error("Invalid session id");
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      if (isCodexChat)
        await runDsh(body.messages, res, {
          provider: "openai-codex",
          model: codex.modelId,
          reasoningEffort: "medium",
          maxTokens: 4096,
          mode: "codex-subscription",
        });
      else
        await runDsh(body.messages, res, {
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
          maxTokens: 2048,
          mode: "demo",
        });
    } catch {
      if (!res.headersSent) res.writeHead(400);
      if (!res.destroyed) res.end("无效的对话请求。");
    } finally {
      admittedRequests--;
    }
  });

  try {
    await new Promise((resolveListen, reject) => {
      api.once("error", reject);
      api.listen(port, host, () => resolveListen(undefined));
    });
  } catch (error) {
    await closeServer(model);
    await codex.close();
    throw error;
  }

  let closed = false;
  return {
    url: `http://${host}:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      shuttingDown = true;
      for (const child of children) child.kill();
      await Promise.all([closeServer(api), closeServer(model), codex.close()]);
    },
  };
}

export { readJson } from "./validation.mjs";
