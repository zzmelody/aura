import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FlowCatalog, FlowRun } from "@aura/protocol/types";
import {
  CodedFlowError,
  FlowError,
  flowErrorBody,
} from "@aura/protocol/errors";
import { ActionFailure } from "@aura/orchestration/action";
import type { OrchestrationHost } from "./dsh/host.ts";

async function readBody(context: Context): Promise<Record<string, unknown>> {
  try {
    const value = (await context.req.json()) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Invalid object");
    return value as Record<string, unknown>;
  } catch {
    throw new CodedFlowError("Flow 请求必须是有效的 JSON 对象。", 400, {
      code: "flow_request_invalid",
    });
  }
}

/** Builds the Hono router mounted by runtime under the `/flows` namespace. */
export function createFlowApp(
  host: Pick<OrchestrationHost, "request"> &
    Partial<
      Pick<
        OrchestrationHost,
        "artifactContent" | "uploadImage" | "imageAssetContent" | "pluginHttp"
      >
    >,
) {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const plugin = await host.pluginHttp?.(context.req.raw);
    if (plugin) return plugin;
    await next();
  });
  // Register the upload limit on its route so it also applies under a mount.
  app.post(
    "/assets/images",
    bodyLimit({
      maxSize: 32 * 1024 * 1024,
      onError: (context) =>
        context.json(
          {
            message: "图片不能超过 32 MB。",
            code: "image_too_large",
            params: { limitMiB: 32 },
          },
          413,
        ),
    }),
    async (context) => {
      if (!host.uploadImage)
        throw new CodedFlowError("图片资产服务不可用。", 503, {
          code: "image_service_unavailable",
        });
      const mediaType = context.req
        .header("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType ?? ""))
        throw new CodedFlowError("请上传 PNG、JPEG 或 WebP 图片。", 415, {
          code: "image_type_unsupported",
        });
      const bytes = new Uint8Array(await context.req.arrayBuffer());
      try {
        const asset = await host.uploadImage(bytes, context.req.raw.signal);
        return context.json(
          {
            assetId: asset.artifactId,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            bytes: asset.bytes,
          },
          201,
        );
      } catch (error) {
        if (context.req.raw.signal.aborted) throw error;
        if (error instanceof ActionFailure)
          throw new FlowError(error.message, 400);
        throw error;
      }
    },
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (context) =>
        context.json(
          {
            message: "Flow 请求过大。",
            code: "flow_request_too_large",
            params: { limitKiB: 256 },
          },
          413,
        ),
    }),
  );

  app.get("/assets/images/:id", async (context) => {
    if (!host.imageAssetContent)
      throw new CodedFlowError("图片资产服务不可用。", 503, {
        code: "image_service_unavailable",
      });
    return host.imageAssetContent(context.req.param("id"), context.req.raw);
  });

  app.get("/catalog", async (context) => {
    const body = JSON.stringify(await host.request("catalog"));
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    context.header("ETag", etag);
    context.header("Cache-Control", "private, no-cache");
    if (context.req.header("If-None-Match") === etag)
      return context.body(null, 304);
    return context.body(body, 200, { "Content-Type": "application/json" });
  });
  app.get("/services", async (context) => {
    const catalog = await host.request<FlowCatalog>("catalog");
    return context.json({
      flows: catalog.flows
        .filter((flow) => flow.available && flow.service)
        .map((flow) => ({
          ...flow,
          invokePath: `/flows/${encodeURIComponent(flow.id)}/invoke`,
        })),
    });
  });
  app.get("/runs", async (context) => context.json(await host.request("list")));
  app.get("/runs/:id/artifacts", async (context) =>
    context.json(
      await host.request("artifacts/list", {
        id: context.req.param("id"),
        retry: context.req.query("retry") === "1",
      }),
    ),
  );
  for (const variant of ["content", "thumbnail"] as const) {
    app.on(
      ["GET", "HEAD"],
      `/runs/:id/artifacts/:artifactId/${variant}`,
      async (context) => {
        if (!host.artifactContent)
          throw new CodedFlowError("产物读取服务不可用。", 503, {
            code: "artifact_service_unavailable",
          });
        return host.artifactContent(
          context.req.param("id"),
          context.req.param("artifactId"),
          variant === "thumbnail",
          context.req.raw,
        );
      },
    );
  }
  app.get("/:flowId/source", async (context) =>
    context.json(
      await host.request("source", { id: context.req.param("flowId") }),
    ),
  );
  app.get("/runs/:id", async (context) =>
    context.json(await host.request("get", { id: context.req.param("id") })),
  );
  for (const method of ["cancel", "pause", "resume"] as const)
    app.post(`/runs/:id/${method}`, async (context) =>
      context.json(
        await host.request(method, {
          ...(await readBody(context)),
          id: context.req.param("id"),
        }),
      ),
    );
  for (const method of ["answer", "resolve"] as const)
    app.post(`/runs/:id/steps/:stepKey/${method}`, async (context) =>
      context.json(
        await host.request(method, {
          ...(await readBody(context)),
          id: context.req.param("id"),
          stepKey: context.req.param("stepKey"),
        }),
      ),
    );
  app.get("/runs/:id/steps/:stepId/history", async (context) => {
    const beforeSeq = context.req.query("beforeSeq");
    const attempt = context.req.query("attempt");
    return context.json(
      await host.request("history", {
        id: context.req.param("id"),
        stepId: context.req.param("stepId"),
        ...(beforeSeq === undefined ? {} : { beforeSeq: Number(beforeSeq) }),
        ...(attempt === undefined ? {} : { attempt: Number(attempt) }),
      }),
    );
  });
  app.post("/:flowId/runs", async (context) => {
    const body = await readBody(context);
    const run = await host.request<FlowRun>("start", {
      ...body,
      flowId: context.req.param("flowId"),
    });
    return context.json({ runId: run.id }, 202);
  });
  app.post("/:flowId/invoke", async (context) => {
    const body = await readBody(context);
    const headerRequestId = context.req.header("Idempotency-Key")?.trim();
    if (
      headerRequestId &&
      typeof body.requestId === "string" &&
      body.requestId !== headerRequestId
    )
      throw new CodedFlowError(
        "Idempotency-Key 与请求体 requestId 必须一致。",
        409,
        { code: "request_id_conflict" },
      );
    const requestId = headerRequestId || body.requestId || randomUUID();
    const run = await host.request<FlowRun>("start", {
      ...body,
      requestId,
      flowId: context.req.param("flowId"),
      serviceOnly: true,
    });
    const self = `/flows/runs/${encodeURIComponent(run.id)}`;
    context.header("Location", self);
    return context.json(
      {
        runId: run.id,
        requestId: run.requestId,
        status: run.status,
        links: {
          self,
          cancel: `${self}/cancel`,
        },
      },
      202,
    );
  });

  app.all("*", (context) =>
    context.json(
      { message: "编排接口不存在。", code: "flow_endpoint_not_found" },
      404,
    ),
  );
  app.onError((error, context) => {
    const status = error instanceof FlowError ? error.status : 500;
    return context.json(
      error instanceof FlowError
        ? flowErrorBody(error)
        : { message: "编排请求失败。", code: "flow_request_failed" },
      status as ContentfulStatusCode,
    );
  });
  return app;
}
