import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { OrchestrationHost } from "@aura/orchestration";
import { FlowError } from "@aura/orchestration";
import { isRecord, validCodingImages } from "./validation.ts";
import { validateChatModelSelection } from "@aura/protocol";

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

  // Stop works even when the turn's stream is not this client's (after a
  // reload) or a proxy keeps the upstream connection open after an abort.
  app.post("/sessions/:id/stop", async (context) => {
    try {
      return context.json(await host.stopCoding(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });

  // Guidance for a turn already running. Its events stay on the request that
  // started the turn, so this answers with admission alone; a conversation
  // with nothing running reports `steered: false` rather than starting a turn.
  app.post("/sessions/:id/steer", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (
      !isRecord(body) ||
      typeof body.prompt !== "string" ||
      body.prompt.length > 80_000 ||
      !validCodingImages(body.images) ||
      // An image-only message is allowed; an empty one is not.
      (!body.prompt.trim() && !(body.images as string[] | undefined)?.length)
    )
      return context.json({ message: "无效的引导内容。" }, 400);
    try {
      return context.json(
        await host.steerCoding(
          context.req.param("id"),
          body.prompt,
          body.images as string[] | undefined,
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  // Opening the panel is durable even before its first request.
  app.post("/sessions/:id/model", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (
      !isRecord(body) ||
      !["demo", "codex", "lumina", "custom"].includes(String(body.mode)) ||
      !validateChatModelSelection(body.selection)
    )
      return context.json({ message: "无效的模型配置。" }, 400);
    try {
      return context.json(
        await host.selectConversationModel(
          context.req.param("id"),
          body.mode as "demo" | "codex" | "lumina" | "custom",
          body.selection,
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  app.post("/sessions/:id/side", async (context) => {
    try {
      return context.json(await host.openCodingSide(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });

  app.post("/sessions/:id/archive", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.archived !== "boolean")
      return context.json({ message: "无效的归档状态。" }, 400);
    try {
      await host.archiveCodingConversation(
        context.req.param("id"),
        body.archived,
      );
      return context.json({ updated: true });
    } catch (error) {
      return failure(context, error);
    }
  });

  app.delete("/sessions/:id", async (context) => {
    try {
      await host.closeCodingConversation(context.req.param("id"));
      return context.json({ updated: true });
    } catch (error) {
      return failure(context, error);
    }
  });

  // Only explicit closure clears the side's durable association.
  app.delete("/sessions/:id/side", async (context) => {
    try {
      return context.json(await host.closeCodingSide(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });

  // Automation tasks: DSH Schedule reminders delivered into a conversation.
  app.get("/automation", async (context) => {
    try {
      return context.json(await host.automationTasks());
    } catch (error) {
      return failure(context, error);
    }
  });

  app.post("/automation", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (!isRecord(body)) return context.json({ message: "无效的任务。" }, 400);
    try {
      return context.json(await host.createAutomationTask(body), 201);
    } catch (error) {
      return failure(context, error);
    }
  });

  // POST like every other coding mutation: runtime CORS admits GET/POST only.
  app.post("/automation/:sessionId/:id", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (!isRecord(body)) return context.json({ message: "无效的任务。" }, 400);
    try {
      return context.json(
        await host.updateAutomationTask(context.req.param("id"), {
          ...body,
          sessionId: context.req.param("sessionId"),
        }),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  app.post("/automation/:sessionId/:id/delete", async (context) => {
    try {
      return context.json(
        await host.deleteAutomationTask(
          context.req.param("sessionId"),
          context.req.param("id"),
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  app.get("/automation/:sessionId/:id/history", async (context) => {
    try {
      return context.json(
        await host.automationHistory(
          context.req.param("sessionId"),
          context.req.param("id"),
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

function failure(
  context: {
    json: (body: unknown, status: 400 | 404 | 409 | 500 | 503) => Response;
  },
  error: unknown,
) {
  if (error instanceof FlowError)
    return context.json(
      { message: error.message },
      error.status === 404
        ? 404
        : error.status === 400
          ? 400
          : error.status === 409
            ? 409
            : error.status === 503
              ? 503
              : 500,
    );
  return context.json({ message: "编码项目操作失败。" }, 500);
}
