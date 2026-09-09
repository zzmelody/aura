import { createServer } from "node:http";
import { validateMessages } from "@aura/protocol";
import { handleFlowRequest, type OrchestrationHost } from "@aura/orchestration";
import { handleCodexAuthRoute } from "./codex-auth-routes.ts";
import {
  allowRequestOrigin,
  closeHttpServer,
  formatHttpUrl,
  listenHttpServer,
  sendJson,
} from "./http-server.ts";
import type {
  ApiServerHandle,
  CodexAuthPort,
  DshSessionPort,
  RuntimeConfig,
} from "./types.ts";
import { isRecord, readJson } from "./validation.ts";

interface ApiServerOptions {
  config: RuntimeConfig;
  codexAuth: CodexAuthPort;
  dsh: DshSessionPort;
  flows?: OrchestrationHost;
}

/** Starts the local Aura HTTP boundary over injected runtime services. */
export async function startApiServer({
  config,
  codexAuth,
  dsh,
  flows,
}: ApiServerOptions): Promise<ApiServerHandle> {
  let shuttingDown = false;
  let admittedRequests = 0;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (!allowRequestOrigin(request, response)) {
          response.writeHead(403).end();
          return;
        }
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, OPTIONS",
        );
        if (request.method === "OPTIONS") {
          response.writeHead(204).end();
          return;
        }
        if (request.method === "GET" && request.url === "/health") {
          sendJson(response, 200, {
            service: "aura-runtime",
            modes: ["dsh-demo", "codex-subscription"],
            keyRequired: false,
          });
          return;
        }
        if (await handleCodexAuthRoute(request, response, codexAuth)) return;
        if (flows && (await handleFlowRequest(flows, request, response)))
          return;

        const demoChat = request.method === "POST" && request.url === "/chat";
        const codexChat =
          request.method === "POST" && request.url === "/chat/codex";
        if (!demoChat && !codexChat) {
          response.writeHead(404).end();
          return;
        }
        if (shuttingDown || admittedRequests >= 2) {
          response.writeHead(503).end("服务忙，请稍后再试。");
          return;
        }

        admittedRequests++;
        try {
          const body = await readJson(request);
          if (
            !isRecord(body) ||
            !validateMessages(body.messages) ||
            typeof body.sessionId !== "string" ||
            body.sessionId.length < 1 ||
            body.sessionId.length > 200
          )
            throw new Error("Invalid chat request.");

          response.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          await dsh.stream(
            body.messages,
            response,
            codexChat
              ? {
                  provider: "openai-codex",
                  model: codexAuth.modelId,
                  reasoningEffort: "medium",
                  maxTokens: 4_096,
                  mode: "codex-subscription",
                }
              : {
                  provider: "deepseek-official",
                  model: "deepseek-v4-flash",
                  reasoningEffort: "off",
                  maxTokens: 2_048,
                  mode: "demo",
                },
          );
        } catch {
          if (!response.headersSent) response.writeHead(400);
          if (!response.destroyed) response.end("无效的对话请求。");
        } finally {
          admittedRequests--;
        }
      } catch {
        sendJson(response, 500, { message: "Aura runtime 请求处理失败。" });
      }
    })();
  });

  await listenHttpServer(server, config.host, config.port);
  return {
    url: formatHttpUrl(config.host, config.port),
    async close() {
      if (shuttingDown) return;
      shuttingDown = true;
      await closeHttpServer(server);
    },
  };
}
