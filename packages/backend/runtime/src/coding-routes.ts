import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { OrchestrationHost } from "@aura/orchestration";
import { FlowError } from "@aura/orchestration";

/**
 * Project management and coding turns for coding mode. The host owns the
 * durable records and the sandbox root; these routes only validate the request
 * shape and project the results.
 */
export function createCodingApp(host: OrchestrationHost) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1_024,
      onError: (context) => context.text("请求内容过大。", 413),
    }),
  );

  app.get("/projects", async (context) => context.json(await host.projects()));

  app.post("/projects", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.directory !== "string")
      return context.json({ message: "缺少项目目录。" }, 400);
    try {
      return context.json(
        await host.createProject(
          body.directory,
          typeof body.title === "string" ? body.title : undefined,
        ),
        201,
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  app.post("/projects/:id/rename", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.title !== "string")
      return context.json({ message: "缺少项目名称。" }, 400);
    try {
      return context.json(
        await host.renameProject(context.req.param("id"), body.title),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  app.post("/projects/:id/directory", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.directory !== "string")
      return context.json({ message: "缺少项目目录。" }, 400);
    try {
      return context.json(
        await host.relocateProject(context.req.param("id"), body.directory),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  app.delete("/projects/:id", async (context) => {
    try {
      const removed = await host.removeProject(context.req.param("id"));
      return context.json({ removed });
    } catch (error) {
      return failure(context, error);
    }
  });

  // The full transcript of one conversation, read back from its session log.
  app.get("/sessions/:id/history", async (context) => {
    try {
      return context.json(await host.codingHistory(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });

  // The agent's pending question resolves only for the session that asked it.
  app.post("/sessions/:id/answer", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (
      !isRecord(body) ||
      typeof body.questionId !== "string" ||
      !Array.isArray(body.answers)
    )
      return context.json({ message: "无效的回答。" }, 400);
    try {
      return context.json(
        await host.answerCoding(
          context.req.param("id"),
          body.questionId,
          body.answers,
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  app.get("/projects/:id/conversations", async (context) => {
    try {
      return context.json(await host.conversations(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });

  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  context: { json: (body: unknown, status: 400 | 404 | 500) => Response },
  error: unknown,
) {
  if (error instanceof FlowError)
    return context.json(
      { message: error.message },
      error.status === 404 ? 404 : error.status === 400 ? 400 : 500,
    );
  return context.json({ message: "编码项目操作失败。" }, 500);
}
