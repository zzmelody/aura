import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { FlowError, type OrchestrationHost } from "./dsh/host.ts";
import { flowErrorBody } from "@aura/protocol/errors";
import type {
  AgentTeamView,
  ConversationSearchHit,
  IntegrationFlags,
  IntegrationSettings,
  MarketListing,
} from "@aura/protocol/types";

export function createIntegrationApp(
  host: Pick<OrchestrationHost, "request" | "transcribeVoice">,
  local: boolean,
) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, context) =>
    error instanceof FlowError
      ? context.json(
          flowErrorBody(error),
          error.status === 400
            ? 400
            : error.status === 409
              ? 409
              : error.status === 422
                ? 422
                : error.status === 502
                  ? 502
                  : 503,
        )
      : context.json(
          { message: "暂时无法使用此功能。", code: "integration_unavailable" },
          503,
        ),
  );
  app.use("/settings", async (context, next) => {
    if (!local)
      return context.json(
        {
          message: "功能开关和 MCP 配置只能通过本机 Aura 服务修改。",
          code: "integrations_local_only",
        },
        403,
      );
    await next();
  });
  app.get("/flags", async (context) =>
    context.json(await host.request<IntegrationFlags>("integrations/flags")),
  );
  app.get("/settings", async (context) =>
    context.json(
      await host.request<IntegrationSettings>("integrations/settings"),
    ),
  );
  app.post(
    "/settings",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json(
          { message: "功能设置内容过大。", code: "integrations_too_large" },
          413,
        ),
    }),
    async (context) => {
      const body: unknown = await context.req.json().catch(() => undefined);
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return context.json(
          {
            message: "功能设置不是有效 JSON。",
            code: "integrations_json_invalid",
          },
          400,
        );
      return context.json(
        await host.request<IntegrationSettings>("integrations/save", body),
      );
    },
  );
  app.get("/search", async (context) =>
    context.json(
      await host.request<ConversationSearchHit[]>("integrations/search", {
        ...(context.req.query("project")
          ? { projectId: context.req.query("project") }
          : {}),
        query: context.req.query("q"),
      }),
    ),
  );
  app.get("/team/:id", async (context) =>
    context.json(
      await host.request<AgentTeamView>("integrations/team", {
        id: context.req.param("id"),
      }),
    ),
  );
  app.get("/market", async (context) =>
    context.json(
      await host.request<MarketListing[]>("integrations/market", {
        query: context.req.query("q"),
      }),
    ),
  );
  app.get("/voice", async (context) => {
    const { voicePhase } = await host.request<IntegrationSettings>(
      "integrations/settings",
    );
    return context.json({ phase: voicePhase });
  });
  app.post("/voice/:action{prepare|cancel}", async (context) => {
    if (!local)
      return context.json(
        {
          message: "请在 Aura 服务所在设备准备语音模型。",
          code: "voice_prepare_local_only",
        },
        403,
      );
    const { voicePhase } = await host.request<IntegrationSettings>(
      "integrations/voice/prepare",
      {
        cancel: context.req.param("action") === "cancel",
      },
    );
    return context.json({ phase: voicePhase });
  });
  app.post(
    "/voice/transcribe",
    bodyLimit({
      maxSize: 960_044,
      onError: (context) =>
        context.json(
          {
            message: "录音文件超过 30 秒的大小上限。",
            code: "voice_recording_too_large",
          },
          413,
        ),
    }),
    async (context) => {
      const type = context.req
        .header("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      if (type !== "audio/wav")
        return context.json(
          { message: "需要 WAV 录音。", code: "voice_format_invalid" },
          415,
        );
      const audio = Buffer.from(await context.req.arrayBuffer());
      return context.json(
        await host.transcribeVoice(
          randomUUID(),
          audio.toString("base64"),
          context.req.raw.signal,
        ),
      );
    },
  );
  return app;
}
