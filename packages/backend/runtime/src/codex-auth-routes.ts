import type { CodexLoginRequest } from "@aura/protocol/types";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isRecord } from "./validation.ts";
import type { CodexAuthPort } from "./types.ts";

function loginMethod(value: unknown): CodexLoginRequest["method"] | undefined {
  return value === "browser" || value === "device_code" ? value : undefined;
}

/** Builds the credential-free HTTP projection of DSH Codex authorization. */
export function createCodexAuthApp(authorization: CodexAuthPort) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/status", async (context) =>
    context.json(await authorization.status()),
  );

  app.post(
    "/start",
    bodyLimit({
      maxSize: 4_096,
      onError: (context) =>
        context.json({ message: "无法开始 Codex 登录。" }, 413),
    }),
    async (context) => {
      try {
        const body = (await context.req.json()) as unknown;
        const method = isRecord(body) ? loginMethod(body.method) : undefined;
        if (!method) throw new Error("Invalid login method.");
        return context.json(await authorization.startLogin(method));
      } catch {
        return context.json({ message: "无法开始 Codex 登录。" }, 400);
      }
    },
  );

  app.post(
    "/complete",
    bodyLimit({
      maxSize: 16 * 1_024,
      onError: (context) =>
        context.json({ message: "授权结果请求过大。" }, 413),
    }),
    async (context) => {
      try {
        const body = (await context.req.json()) as unknown;
        const input = isRecord(body) ? body.input : undefined;
        return context.json(authorization.submitLoginInput(input));
      } catch (error) {
        return context.json(
          {
            message:
              error instanceof Error
                ? error.message
                : "无法提交 Codex 授权结果。",
          },
          409,
        );
      }
    },
  );

  app.post("/cancel", async (context) =>
    context.json(await authorization.cancelLogin()),
  );
  return app;
}
