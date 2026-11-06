import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { FlowError, type OrchestrationHost } from "./dsh/host.ts";
import { flowErrorBody } from "@aura/protocol/errors";
import type { PluginPageRegistry } from "./plugin-pages.ts";

/**
 * Workbench pages: DSH combo scripts, the live graph, SSE graph/rebuild
 * frames, and a per-plugin backend invoke that never reaches other
 * plugins. Page configuration is not here; `/plugins/config` stays the
 * loopback-only directory boundary.
 */
export function createPluginPagesApp(
  pages: PluginPageRegistry,
  flows: Pick<OrchestrationHost, "request"> | undefined,
) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/pages", (context) => {
    const snapshot = pages.snapshot();
    return context.json({
      rev: snapshot.rev,
      loader: snapshot.loader,
      bundles: snapshot.bundles,
    });
  });

  app.get("/graph", (context) => context.json(pages.snapshot().graph));

  app.get("/events", (context) =>
    streamSSE(context, async (stream) => {
      const send = () =>
        stream.writeSSE({
          event: "graph",
          data: JSON.stringify({
            type: "graph",
            graph: pages.snapshot().graph,
          }),
        });
      await new Promise<void>((resolve) => {
        const finish = () => {
          unsubscribe();
          clearInterval(heartbeat);
          context.req.raw.signal.removeEventListener("abort", finish);
          resolve();
        };
        const unsubscribe = pages.onChange(() => {
          void send().catch(finish);
        });
        const heartbeat = setInterval(() => {
          void stream.writeSSE({ event: "ping", data: "{}" }).catch(finish);
        }, 15_000);
        context.req.raw.signal.addEventListener("abort", finish, {
          once: true,
        });
        stream.onAbort(finish);
        if (context.req.raw.signal.aborted || stream.aborted) finish();
        else void send().catch(finish);
      });
    }),
  );

  app.post(
    "/pages/:pluginId/invoke",
    bodyLimit({
      maxSize: 4 * 1_024 * 1_024,
      onError: (context) =>
        context.json(
          { message: "插件页面请求过大。", code: "plugin_page_too_large" },
          413,
        ),
    }),
    async (context) => {
      if (!flows)
        return context.json(
          { message: "编排服务暂时不可用。", code: "service_unavailable" },
          503,
        );
      const pluginId = context.req.param("pluginId");
      if (
        !pages
          .snapshot()
          .bundles.some((bundle) => bundle.plugin.id === pluginId)
      )
        return context.json(
          { message: "插件页面未启用。", code: "plugin_page_disabled" },
          404,
        );
      const body = (await context.req.json().catch(() => undefined)) as
        { operation?: unknown; input?: unknown } | undefined;
      if (
        !body ||
        typeof body.operation !== "string" ||
        !/^[a-z][a-z0-9_.-]{0,63}$/u.test(body.operation)
      )
        return context.json(
          {
            message: "页面调用的 operation 无效。",
            code: "plugin_operation_invalid",
          },
          400,
        );
      try {
        return context.json(
          await flows.request(
            "plugins/page-invoke",
            {
              pluginId,
              operation: body.operation,
              input: body.input ?? null,
            },
            AbortSignal.any([
              context.req.raw.signal,
              AbortSignal.timeout(120_000),
            ]),
          ),
        );
      } catch (error) {
        if (error instanceof FlowError)
          return context.json(
            flowErrorBody(error),
            error.status as ContentfulStatusCode,
          );
        throw error;
      }
    },
  );

  return app;
}

/**
 * Serves DSH combo URLs at `/plugins/??<id>/client.js&rev=<rev>`. Hono's
 * path parser treats `??` as the query, so the raw URL is matched here.
 */
export function pluginBundleFallback(pages: PluginPageRegistry) {
  return (request: Request): Response | undefined => {
    const resource = pages.resource(request.url);
    if (resource.status === 404) return undefined;
    return new Response(
      request.method === "HEAD" || !resource.body
        ? null
        : new Uint8Array(resource.body),
      { status: resource.status, headers: resource.headers },
    );
  };
}
