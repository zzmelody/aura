import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AiConfigurationError } from "@aura/dsh-auth";
import type { AiServicesPort } from "./ai-services.ts";

/**
 * Only a loopback-bound runtime manages secrets. The native game presents its
 * bootstrap capability; the local workbench, like plugin settings, relies on
 * the loopback binding and origin policy. A wrong capability is always refused.
 */
export function createAiServicesApp(
  services: AiServicesPort,
  accessible: boolean,
  token?: string,
) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (!accessible)
      return context.json({ message: "AI 配置仅供本机客户端使用。" }, 403);
    const header = context.req.header("authorization");
    if (header !== undefined) {
      const actual = Buffer.from(header.replace(/^Bearer /u, ""));
      const expected = Buffer.from(token ?? "");
      if (
        !token ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return context.json(
          { message: "客户端授权已失效，请重新连接创作服务。" },
          401,
        );
    }
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) => context.json({ message: "AI 设置请求过大。" }, 413),
    }),
  );
  app.get("/", async (context) => context.json(await services.settings()));
  app.post("/model", async (context) =>
    context.json(await services.saveModel(await context.req.json())),
  );
  app.post("/lumina", async (context) =>
    context.json(await services.saveLumina(await context.req.json())),
  );
  app.post("/check/lumina", async (context) =>
    context.json(
      await services.checkLumina(
        AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15_000)]),
      ),
    ),
  );
  app.post("/check/model", async (context) =>
    context.json(
      await services.checkModel(
        AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(60_000)]),
      ),
    ),
  );
  app.post("/models", async (context) =>
    context.json(
      await services.refreshModels(
        AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15_000)]),
      ),
    ),
  );
  app.post("/codex/logout", async (context) =>
    context.json(await services.logout()),
  );
  app.onError((error, context) =>
    context.json(
      {
        message:
          error instanceof AiConfigurationError
            ? error.message
            : "AI 配置操作失败，请检查服务连接后重试。",
      },
      400,
    ),
  );
  return app;
}
