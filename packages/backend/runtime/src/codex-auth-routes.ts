import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodexLoginRequest } from "@aura/protocol/types";
import { sendJson } from "./http-server.ts";
import { isRecord, readJson } from "./validation.ts";
import type { CodexAuthPort } from "./types.ts";

function loginMethod(value: unknown): CodexLoginRequest["method"] | undefined {
  return value === "browser" || value === "device_code" ? value : undefined;
}

/** Handles only the public, credential-free projection of DSH Codex auth. */
export async function handleCodexAuthRoute(
  request: IncomingMessage,
  response: ServerResponse,
  authorization: CodexAuthPort,
): Promise<boolean> {
  if (request.method === "GET" && request.url === "/auth/codex/status") {
    sendJson(response, 200, await authorization.status());
    return true;
  }

  if (request.method === "POST" && request.url === "/auth/codex/start") {
    try {
      const body = await readJson(request, 4_096);
      const method = isRecord(body) ? loginMethod(body.method) : undefined;
      if (!method) throw new Error("Invalid login method.");
      sendJson(response, 200, await authorization.startLogin(method));
    } catch {
      sendJson(response, 400, { message: "无法开始 Codex 登录。" });
    }
    return true;
  }

  if (request.method === "POST" && request.url === "/auth/codex/complete") {
    try {
      const body = await readJson(request, 16 * 1_024);
      const input = isRecord(body) ? body.input : undefined;
      sendJson(response, 200, authorization.submitLoginInput(input));
    } catch (error) {
      sendJson(response, 409, {
        message:
          error instanceof Error ? error.message : "无法提交 Codex 授权结果。",
      });
    }
    return true;
  }

  if (request.method === "POST" && request.url === "/auth/codex/cancel") {
    sendJson(response, 200, await authorization.cancelLogin());
    return true;
  }

  return false;
}
