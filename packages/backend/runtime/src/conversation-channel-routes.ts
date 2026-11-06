import { CodedFlowError } from "@aura/protocol/errors";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { setTimeout as delay } from "node:timers/promises";
import { FlowError, type OrchestrationHost } from "./dsh/host.ts";
import { flowErrorBody } from "@aura/protocol/errors";
import { isConversationCursor } from "@aura/protocol/conversation-channel";
import type {
  ConversationEventPage,
  ConversationReceipt,
  ConversationSnapshot,
} from "@aura/protocol/conversation-channel";

/** The HTTP connection owns only its reader; execution lives in agent-runtime. */
export function createConversationChannelApp(
  host: Pick<OrchestrationHost, "request">,
) {
  const app = new Hono();
  app.onError((error, context) => {
    const status =
      error instanceof FlowError &&
      [400, 404, 409, 413, 503].includes(error.status)
        ? (error.status as 400 | 404 | 409 | 413 | 503)
        : 500;
    return context.json(
      error instanceof FlowError
        ? flowErrorBody(error)
        : { message: "会话连接暂时不可用。", code: "conversation_unavailable" },
      status,
    );
  });
  app.use("/:id/*", async (context, next) => {
    if (!context.req.param("id") || context.req.param("id")!.length > 200)
      throw new CodedFlowError("无效的对话。", 400, {
        code: "conversation_request_invalid",
      });
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.post("/:id/commands", async (context) => {
    const command: unknown = await context.req.json().catch(() => undefined);
    // No HTTP AbortSignal crosses the durable command admission boundary.
    const receipt = await host.request<ConversationReceipt>("coding/commands", {
      sessionId: context.req.param("id"),
      command,
    });
    return context.json(receipt, receipt.status === "accepted" ? 202 : 200);
  });
  app.get("/:id/commands/:commandId", async (context) =>
    context.json(
      await host.request<ConversationReceipt>(
        "coding/commands/read",
        {
          sessionId: context.req.param("id"),
          commandId: context.req.param("commandId"),
        },
        context.req.raw.signal,
      ),
    ),
  );
  app.get("/:id/snapshot", async (context) =>
    context.json(
      await host.request<ConversationSnapshot>(
        "coding/snapshot",
        { sessionId: context.req.param("id") },
        context.req.raw.signal,
      ),
    ),
  );
  app.get("/:id/events", async (context) => {
    const sessionId = context.req.param("id");
    let cursor =
      context.req.header("Last-Event-ID") ?? context.req.query("cursor");
    if (cursor !== undefined && !isConversationCursor(cursor))
      throw new CodedFlowError("无效的事件游标。", 400, {
        code: "conversation_cursor_invalid",
      });
    const initial = await host.request<ConversationEventPage>(
      "coding/events",
      { sessionId, cursor },
      context.req.raw.signal,
    );
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (output) => {
      const abort = new AbortController();
      output.onAbort(() => abort.abort());
      let page = initial;
      let heartbeat = Date.now();
      try {
        while (!abort.signal.aborted) {
          if (page.reset) {
            const snapshot = await host.request<ConversationSnapshot>(
              "coding/snapshot",
              { sessionId },
              abort.signal,
            );
            await output.writeSSE({
              event: cursor ? "reset" : "snapshot",
              id: snapshot.cursor,
              data: JSON.stringify(snapshot),
            });
            cursor = snapshot.cursor;
          } else {
            for (const event of page.events) {
              await output.writeSSE({
                event: "event",
                id: event.cursor,
                data: JSON.stringify(event),
              });
              cursor = event.cursor;
            }
            cursor = page.cursor;
          }
          if (Date.now() - heartbeat > 10_000) {
            await output.writeSSE({ event: "heartbeat", data: "{}" });
            heartbeat = Date.now();
          }
          await delay(150, undefined, { signal: abort.signal });
          page = await host.request<ConversationEventPage>(
            "coding/events",
            { sessionId, cursor },
            abort.signal,
          );
        }
      } catch {
        if (!abort.signal.aborted)
          await output
            .writeSSE({ event: "unavailable", data: "{}" })
            .catch(() => undefined);
      }
    });
  });
  return app;
}
