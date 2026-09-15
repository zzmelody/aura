import type {
  TripoGenerationOptions,
  TripoImageToModelRequest,
  TripoTextToModelRequest,
} from "@aura/protocol/types";
import { TripoNotConfiguredError, type TripoPort } from "@aura/tripo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isRecord } from "./validation.ts";

const generationKeys = new Set([
  "model",
  "texture",
  "pbr",
  "faceLimit",
  "textureQuality",
  "geometryQuality",
  "quad",
  "generateParts",
]);

function hasOnlyKeys(body: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(body).every((key) => allowed.has(key));
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function optionalQuality(
  value: unknown,
): value is "standard" | "detailed" | undefined {
  return value === undefined || value === "standard" || value === "detailed";
}

function parseGenerationOptions(
  body: Record<string, unknown>,
): TripoGenerationOptions | undefined {
  if (
    !optionalBoolean(body.texture) ||
    !optionalBoolean(body.pbr) ||
    !optionalBoolean(body.quad) ||
    !optionalBoolean(body.generateParts) ||
    !optionalQuality(body.textureQuality) ||
    !optionalQuality(body.geometryQuality) ||
    (body.model !== undefined &&
      (typeof body.model !== "string" ||
        body.model.length < 1 ||
        body.model.length > 128)) ||
    (body.faceLimit !== undefined &&
      (!Number.isSafeInteger(body.faceLimit) ||
        (body.faceLimit as number) < 1 ||
        (body.faceLimit as number) > 1_000_000))
  )
    return undefined;

  return {
    model: body.model as string | undefined,
    texture: body.texture,
    pbr: body.pbr,
    faceLimit: body.faceLimit as number | undefined,
    textureQuality: body.textureQuality as "standard" | "detailed" | undefined,
    geometryQuality: body.geometryQuality as
      "standard" | "detailed" | undefined,
    quad: body.quad,
    generateParts: body.generateParts,
  };
}

function parseTextRequest(value: unknown): TripoTextToModelRequest | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([...generationKeys, "prompt", "negativePrompt"]);
  if (
    !hasOnlyKeys(value, allowed) ||
    typeof value.prompt !== "string" ||
    value.prompt.trim().length < 1 ||
    value.prompt.length > 1_024 ||
    (value.negativePrompt !== undefined &&
      (typeof value.negativePrompt !== "string" ||
        value.negativePrompt.length > 1_024))
  )
    return undefined;
  const options = parseGenerationOptions(value);
  return options
    ? {
        ...options,
        prompt: value.prompt,
        negativePrompt: value.negativePrompt as string | undefined,
      }
    : undefined;
}

function parseImageRequest(
  value: unknown,
): TripoImageToModelRequest | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([...generationKeys, "image"]);
  if (!hasOnlyKeys(value, allowed) || !isRecord(value.image)) return undefined;
  const imageKeys = Object.keys(value.image);
  let image: TripoImageToModelRequest["image"] | undefined;
  if (
    imageKeys.length === 1 &&
    typeof value.image.url === "string" &&
    value.image.url.length <= 4_096
  ) {
    try {
      const url = new URL(value.image.url);
      if (url.protocol === "https:" && !url.username && !url.password)
        image = { url: url.href };
    } catch {
      // The stable client validation response is returned below.
    }
  } else if (
    imageKeys.length === 1 &&
    typeof value.image.fileToken === "string" &&
    /^[A-Za-z0-9_-]{1,512}$/.test(value.image.fileToken)
  ) {
    image = { fileToken: value.image.fileToken };
  }
  const options = parseGenerationOptions(value);
  return image && options ? { ...options, image } : undefined;
}

function validTaskId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function logUpstreamFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const status =
    isRecord(error) && typeof error.status === "number"
      ? ` (HTTP ${error.status})`
      : "";
  console.error("[Aura Tripo]", `${name}${status}`);
}

function tripoFailure(context: Context, error: unknown) {
  if (error instanceof TripoNotConfiguredError)
    return context.json(
      {
        code: "tripo_not_configured",
        message: "Tripo 尚未配置，请先在后端设置 API Key。",
      },
      503,
    );
  logUpstreamFailure(error);
  return context.json(
    {
      code: "tripo_upstream_error",
      message: "Tripo 请求失败，请稍后重试或检查后端配置。",
    },
    502,
  );
}

/** Builds the credential-free HTTP projection of the backend Tripo adapter. */
export function createTripoApp(tripo: TripoPort) {
  const app = new Hono();
  const jsonLimit = bodyLimit({
    maxSize: 32 * 1_024,
    onError: (context) => context.text("无效的 Tripo 请求。", 413),
  });

  app.get("/status", (context) => context.json(tripo.status()));

  app.post("/tasks/text-to-model", jsonLimit, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.text("无效的 Tripo 文生模型请求。", 400);
    }
    const input = parseTextRequest(body);
    if (!input) return context.text("无效的 Tripo 文生模型请求。", 400);
    try {
      return context.json({ taskId: await tripo.textToModel(input) }, 202);
    } catch (error) {
      return tripoFailure(context, error);
    }
  });

  app.post("/tasks/image-to-model", jsonLimit, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.text("无效的 Tripo 图生模型请求。", 400);
    }
    const input = parseImageRequest(body);
    if (!input) return context.text("无效的 Tripo 图生模型请求。", 400);
    try {
      return context.json({ taskId: await tripo.imageToModel(input) }, 202);
    } catch (error) {
      return tripoFailure(context, error);
    }
  });

  app.get("/tasks/:taskId", async (context) => {
    const taskId = context.req.param("taskId");
    if (!validTaskId(taskId))
      return context.text("无效的 Tripo task ID。", 400);
    try {
      return context.json(await tripo.getTask(taskId));
    } catch (error) {
      return tripoFailure(context, error);
    }
  });

  return app;
}
