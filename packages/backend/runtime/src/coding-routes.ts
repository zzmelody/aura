import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { OrchestrationHost } from "@aura/orchestration";
import { FlowError } from "@aura/orchestration";
import { isRecord, validCodingImages } from "./validation.ts";
import type { CodingSteerModelConfig } from "@aura/protocol/types";
import {
  isCodingPermission,
  isCodingSteerRequestId,
  validateChatModelSelection,
} from "@aura/protocol";
import { createTerminalApp } from "./terminal-routes.ts";

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
  app.route("/terminals", createTerminalApp(host));

  app.get("/sessions/:id/agents", async (context) => {
    try {
      return context.json(await host.codingSubagents(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });
  app.post("/sessions/:id/agents/:child/stop", async (context) => {
    try {
      return context.json(
        await host.stopCodingSubagent(
          context.req.param("id"),
          context.req.param("child"),
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  });
  app.get("/capabilities", async (context) => {
    try {
      return context.json(await host.codingCapabilities());
    } catch (error) {
      return failure(context, error);
    }
  });
  app.post("/capabilities", async (context) => {
    try {
      return context.json(
        await host.codingCapabilities(await context.req.json()),
      );
    } catch (error) {
      return failure(context, error);
    }
  });
  app.post("/sessions/:id/compact", async (context) => {
    try {
      return context.json(await host.compactCoding(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });

  app.get("/assistant", async (context) => {
    try {
      return context.json(await host.personalAssistant(false));
    } catch (error) {
      return failure(context, error);
    }
  });
  app.post("/assistant", async (context) => {
    try {
      return context.json(await host.personalAssistant(true));
    } catch (error) {
      return failure(context, error);
    }
  });

  app.get("/projects", async (context) => context.json(await host.projects()));

  app.get("/projects/:id/skills", async (context) => {
    try {
      return context.json(await host.skills(context.req.param("id")));
    } catch (error) {
      return failure(context, error);
    }
  });

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
      const before = context.req.query("beforeSeq");
      const through = context.req.query("throughSeq");
      if (
        (before !== undefined &&
          (!/^\d+$/u.test(before) || !Number.isSafeInteger(Number(before)))) ||
        (through !== undefined &&
          (!/^\d+$/u.test(through) ||
            !Number.isSafeInteger(Number(through)))) ||
        (before === undefined) !== (through === undefined)
      )
        return context.json({ message: "无效的历史分页游标。" }, 400);
      return context.json(
        await host.codingHistory(
          context.req.param("id"),
          {
            page: context.req.query("page") === "1",
            ...(before !== undefined && through !== undefined
              ? { beforeSeq: Number(before), throughSeq: Number(through) }
              : {}),
          },
          context.req.raw.signal,
        ),
      );
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
      (body.requestId !== undefined &&
        !isCodingSteerRequestId(body.requestId)) ||
      (body.modelConfig !== undefined &&
        (!isRecord(body.modelConfig) ||
          Object.keys(body.modelConfig).some(
            (key) => key !== "mode" && key !== "selection",
          ) ||
          typeof body.modelConfig.mode !== "string" ||
          !["demo", "codex", "lumina", "custom"].includes(
            body.modelConfig.mode,
          ) ||
          !validateChatModelSelection(body.modelConfig.selection))) ||
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
          body.modelConfig as CodingSteerModelConfig | undefined,
          body.requestId,
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

  // Durable per conversation; a live agent switches immediately, mid-turn too.
  app.post("/sessions/:id/permission", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "permission") ||
      !isCodingPermission(body.permission)
    )
      return context.json({ message: "无效的权限设置。" }, 400);
    try {
      return context.json(
        await host.selectConversationPermission(
          context.req.param("id"),
          body.permission,
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
    const status = context.req.query("status");
    if (status !== undefined && status !== "metadata" && status !== "full")
      return context.json({ message: "无效的对话状态选项。" }, 400);
    try {
      return context.json(
        await host.conversations(
          context.req.param("id"),
          status !== "metadata",
        ),
      );
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
