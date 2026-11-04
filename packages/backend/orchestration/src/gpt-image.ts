import {
  readCodexImageStream,
  type CodexImageRequest,
} from "./codex-image-transport.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { ActionFailure, type AuraCapabilityClient } from "./action-api.ts";
import type { GeneratedArtifacts } from "./artifacts/generated.ts";
import { z } from "zod";

export const GPT_IMAGE_CAPABILITY = "aura.codex.image";

const imageInput = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    aspect: z.enum(["square", "portrait", "landscape"]),
    quality: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

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

export function gptImageCapability(
  client: GptImageClient,
): AuraCapabilityClient {
  return {
    async invoke(capability, operation, input, signal) {
      signal.throwIfAborted();
      if (capability !== GPT_IMAGE_CAPABILITY)
        throw new ActionFailure("codex_image_capability: 无效的图片能力。");
      if (operation === "available") return client.available();
      if (operation !== "generate")
        throw new ActionFailure("codex_image_operation: 无效的图片操作。");
      const parsed = imageInput.safeParse(input);
      if (!parsed.success)
        throw new ActionFailure("codex_image_input: 无效的图片生成参数。");
      return { ...(await client.generate(parsed.data, signal)) };
    },
  };
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

  async generate(
    input: GptImageInput,
    signal: AbortSignal,
  ): Promise<GptImageResult> {
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
          content: [
            { type: "input_text", text: `画幅：${hint}。\n${input.prompt}` },
          ],
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
      throw new ActionFailure(
        "codex_image_unreachable: 无法连接 Codex，请检查网络或代理。",
        {
          cause: error,
        },
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new ActionFailure(
        "codex_image_signed_out: Codex 登录已失效，请重新登录。",
      );
    if (response.status === 429)
      throw new ActionFailure(
        "codex_image_limited: Codex 使用额度已达上限，请稍后再试。",
      );
    if (!response.ok)
      throw new ActionFailure(
        `codex_image_failed: Codex 返回 HTTP ${response.status}。`,
      );
    const generated = await readCodexImageStream(response);
    const bytes = Buffer.from(generated.bytes);
    const metadata = await sharp(bytes, {
      limitInputPixels: 16_000_000,
      failOn: "error",
    })
      .metadata()
      .catch(() => undefined);
    if (!metadata?.width || !metadata.height || metadata.format !== "png")
      throw new ActionFailure(
        "codex_image_invalid: Codex 返回的图片无法解码。",
      );
    const registered = await this.artifacts.registerImage(bytes, signal);
    // A real file keeps the result previewable in the run card like local images.
    const directory = join(
      this.outputRoot,
      `gpt-${registered.artifactId.slice(0, 16)}`,
    );
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
      ...(generated.revisedPrompt
        ? { revisedPrompt: generated.revisedPrompt }
        : {}),
    };
  }
}

export {
  codexImageRequest,
  readCodexImageStream,
} from "./codex-image-transport.ts";
export type {
  CodexImageRequest,
  CodexImageResponse,
} from "./codex-image-transport.ts";
