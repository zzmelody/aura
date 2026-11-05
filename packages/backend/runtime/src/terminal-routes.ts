import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { setTimeout as delay } from "node:timers/promises";
import { FlowError, type OrchestrationHost } from "./dsh/host.ts";
import type {
  WorkspaceTerminalInfo,
  WorkspaceTerminalOutput,
} from "@aura/protocol/types";
import { isRecord } from "./validation.ts";

/** HTTP clients attach to a PTY; disconnecting the stream never terminates it. */
export function createTerminalApp(host: Pick<OrchestrationHost, "request">) {
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      {
        message:
          error instanceof FlowError
            ? error.message
            : "终端操作未完成，请检查服务连接。",
      },
      error instanceof FlowError && [400, 404, 409, 503].includes(error.status)
        ? (error.status as 400 | 404 | 409 | 503)
        : 500,
    ),
  );
  app.get("/", async (context) =>
    context.json(
      await host.request<WorkspaceTerminalInfo[]>("coding/terminals/list", {
        projectId: context.req.query("projectId"),
      }),
    ),
  );
  app.post("/", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (!isRecord(body)) throw new FlowError("无效的终端请求。", 400);
    return context.json(
      await host.request<WorkspaceTerminalInfo>("coding/terminals/open", {
        projectId: body.projectId,
        cols: body.cols ?? 80,
        rows: body.rows ?? 24,
      }),
    );
  });
  for (const action of ["write", "resize"] as const) {
    app.post(`/:id/${action}`, async (context) => {
      const body: unknown = await context.req.json().catch(() => undefined);
      if (!isRecord(body)) throw new FlowError("无效的终端请求。", 400);
      return context.json(
        await host.request(`coding/terminals/${action}`, {
          terminalId: context.req.param("id"),
          ...(action === "write"
            ? { data: body.data }
            : { cols: body.cols, rows: body.rows }),
        }),
      );
    });
  }
  app.delete("/:id", async (context) =>
    context.json(
      await host.request("coding/terminals/close", {
        terminalId: context.req.param("id"),
        force: context.req.query("force") === "true",
      }),
    ),
  );
  app.get("/:id/events", async (context) => {
    let cursor = Number(
      context.req.header("Last-Event-ID") ?? context.req.query("cursor") ?? 0,
    );
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new FlowError("无效的终端输出位置。", 400);
    const terminalId = context.req.param("id");
    const read = () =>
      host.request<WorkspaceTerminalOutput>("coding/terminals/read", {
        terminalId,
        cursor,
      });
    const initial = await read();
    return streamSSE(context, async (output) => {
      const abort = new AbortController();
      output.onAbort(() => abort.abort());
      let page = initial;
      let previous = "";
      let heartbeat = Date.now();
      try {
        while (!abort.signal.aborted) {
          const state = JSON.stringify(page.terminal);
          if (page.data || page.reset || state !== previous) {
            await output.writeSSE({
              event: "output",
              id: String(page.cursor),
              data: JSON.stringify(page),
            });
            previous = state;
          } else if (Date.now() - heartbeat > 10_000) {
            await output.writeSSE({ event: "heartbeat", data: "{}" });
            heartbeat = Date.now();
          }
          cursor = page.cursor;
          if (page.terminal.status !== "running" && !page.data) break;
          if (page.data.length < 65_536)
            await delay(150, undefined, { signal: abort.signal });
          page = await read();
        }
      } catch {
        if (!abort.signal.aborted)
          await output
            .writeSSE({ event: "unavailable", data: "{}" })
            .catch(() => {});
      }
    });
  });
  return app;
}
