import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { CodexTokenSource } from "@aura/dsh-auth";
import { ActionFailure } from "./action-api.ts";
import type { GeneratedArtifacts } from "./generated-artifacts.ts";

export type GptImageAspect = "square" | "portrait" | "landscape";

/** Sizes the Codex image tool accepts, with an orientation hint for the model. */
export const GPT_IMAGE_SIZES = {
  square: { size: "1024x1024", hint: "方图（1:1）" },
  portrait: { size: "1024x1536", hint: "竖图（2:3）" },
  landscape: { size: "1536x1024", hint: "横图（3:2）" },
} as const;

/**
 * Codex chooses its own image model for the image_generation tool and ignores
 * a model override, so results are labelled by service rather than a version.
 */
export const GPT_IMAGE_MODEL = "codex-image";

export interface GptImageInput {
  prompt: string;
  aspect: GptImageAspect;
  quality?: "low" | "medium" | "high";
}

export interface GptImageResult {
  service: "codex-image";
  model: string;
  files: string[];
  imageAssetId: string;
  width: number;
  height: number;
  revisedPrompt?: string;
}

/** Host port for Actions; tokens and the provider client stay outside. */
export interface GptImageClient {
  /** True while a Codex subscription login is stored. */
  available(): Promise<boolean>;
  generate(input: GptImageInput, signal: AbortSignal): Promise<GptImageResult>;
}

/** Bytes plus what Codex reported; one call is one image tool use. */
export interface CodexImageResponse {
  bytes: Uint8Array;
  revisedPrompt?: string;
}

/** Narrow request port so tests never touch the network or real tokens. */
export type CodexImageRequest = (
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Response>;

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MAX_STREAM_BYTES = 48 * 1024 * 1024;

/**
 * Sends one Responses request with the image_generation tool through the
 * signed-in Codex subscription; the token comes from the shared DSH login.
 */
export function codexImageRequest(
  tokens: CodexTokenSource,
  model: string,
): CodexImageRequest {
  return async (body, signal) => {
    const access = await tokens.token(signal);
    if (!access)
      throw new ActionFailure("codex_image_signed_out: 请先在右上角登录 Codex。");
    return fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${access.token}`,
        "chatgpt-account-id": access.accountId,
        originator: "pi",
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, store: false, stream: true, ...body }),
    });
  };
}

/** Reads a bounded SSE body and returns the finished image tool call. */
export async function readCodexImageStream(response: Response): Promise<CodexImageResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new ActionFailure("codex_image_failed: Codex 没有返回内容。");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_STREAM_BYTES)
        throw new ActionFailure("codex_image_failed: Codex 返回内容超过上限。");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  let image: CodexImageResponse | undefined;
  let failure: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "image_generation_call" &&
      typeof event.item.result === "string"
    )
      image = {
        bytes: Buffer.from(event.item.result, "base64"),
        ...(typeof event.item.revised_prompt === "string"
          ? { revisedPrompt: event.item.revised_prompt.slice(0, 2000) }
          : {}),
      };
    if (event.type === "error" || event.type === "response.failed") {
      const message =
        event.error?.message ?? event.response?.error?.message ?? event.message;
      failure = typeof message === "string" ? message.slice(0, 300) : "未知错误";
    }
  }
  if (image) return image;
  throw new ActionFailure(
    failure
      ? `codex_image_failed: Codex 图片生成失败：${failure}`
      : "codex_image_failed: Codex 没有生成图片，请换个描述再试。",
  );
}

/**
 * GPT image generation through the signed-in Codex subscription. It uses the
 * subscription's Codex quota, not a per-image API bill, and never resubmits
 * after an unknown outcome.
 */
export class GptImageService implements GptImageClient {
  private readonly request: CodexImageRequest;
  private readonly signedIn: () => Promise<boolean>;
  private readonly artifacts: Pick<GeneratedArtifacts, "registerImage">;
  private readonly outputRoot: string;

  constructor(options: {
    request: CodexImageRequest;
    signedIn: () => Promise<boolean>;
    artifacts: Pick<GeneratedArtifacts, "registerImage">;
    outputRoot: string;
  }) {
    this.request = options.request;
    this.signedIn = options.signedIn;
    this.artifacts = options.artifacts;
    this.outputRoot = options.outputRoot;
  }

  async available() {
    try {
      return await this.signedIn();
    } catch {
      return false;
    }
  }

  async generate(input: GptImageInput, signal: AbortSignal): Promise<GptImageResult> {
    const { size, hint } = GPT_IMAGE_SIZES[input.aspect];
    const tool = {
      type: "image_generation",
      output_format: "png",
      size,
      ...(input.quality ? { quality: input.quality } : {}),
    };
    const body = {
      instructions:
        "Call the image_generation tool exactly once to create the image the user describes. Keep the requested orientation. Do not ask questions or add text.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: `画幅：${hint}。\n${input.prompt}` }],
        },
      ],
      tools: [tool],
      tool_choice: "auto",
    };
    let response: Response;
    try {
      // One request per call: an unknown outcome is never resubmitted.
      response = await this.request(body, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ActionFailure) throw error;
      throw new ActionFailure("codex_image_unreachable: 无法连接 Codex，请检查网络或代理。", {
        cause: error,
      });
    }
    if (response.status === 401 || response.status === 403)
      throw new ActionFailure("codex_image_signed_out: Codex 登录已失效，请重新登录。");
    if (response.status === 429)
      throw new ActionFailure("codex_image_limited: Codex 使用额度已达上限，请稍后再试。");
    if (!response.ok)
      throw new ActionFailure(`codex_image_failed: Codex 返回 HTTP ${response.status}。`);
    const generated = await readCodexImageStream(response);
    const bytes = Buffer.from(generated.bytes);
    const metadata = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "error" })
      .metadata()
      .catch(() => undefined);
    if (!metadata?.width || !metadata.height || metadata.format !== "png")
      throw new ActionFailure("codex_image_invalid: Codex 返回的图片无法解码。");
    const registered = await this.artifacts.registerImage(bytes, signal);
    // A real file keeps the result previewable in the run card like local images.
    const directory = join(this.outputRoot, `gpt-${registered.artifactId.slice(0, 16)}`);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "image.png");
    await writeFile(path, bytes);
    return {
      service: "codex-image",
      model: GPT_IMAGE_MODEL,
      files: [path],
      imageAssetId: registered.artifactId,
      width: metadata.width,
      height: metadata.height,
      ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
    };
  }
}
