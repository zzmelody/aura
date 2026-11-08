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
import type { FlowImageReference } from "./flow-api.ts";
import { flowImageSchema } from "./schema.ts";

export const GPT_IMAGE_CAPABILITY = "aura.codex.image";

const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;

/** Only immutable host-owned references cross the capability boundary. */
export type GptImageReference = string | FlowImageReference;

type ReadImageAttachment = (
  reference: FlowImageReference,
  signal: AbortSignal,
) => Promise<Uint8Array>;

function invalidImageInput() {
  return new ActionFailure("codex_image_input: 无效的图片生成参数。", {
    translations: {
      "zh-CN":
        "图片生成参数无效。最多提供 4 张参考图片，仅接受图片资产 ID 或聊天附件引用。",
      en: "Invalid image generation input. Provide at most 4 reference images using image asset IDs or chat attachment references.",
      ja: "画像生成の入力が無効です。画像アセット ID またはチャット添付参照で、最大 4 枚の参考画像を指定してください。",
      ko: "이미지 생성 입력이 올바르지 않습니다. 이미지 에셋 ID 또는 채팅 첨부 참조로 참고 이미지를 최대 4개까지 지정하세요.",
      ru: "Неверные параметры генерации. Укажите не более 4 изображений по ID ресурсов или ссылкам на вложения чата.",
      fr: "Paramètres de génération invalides. Fournissez au maximum 4 images de référence via leurs identifiants de ressources ou leurs références de pièces jointes.",
    },
  });
}

function invalidImageReference() {
  return new ActionFailure(
    "codex_image_reference: 参考图片无法读取或超出限制，请重新上传 PNG、JPEG、WebP 或 GIF 图片，合计不超过 32 MiB。",
    {
      translations: {
        "zh-CN":
          "参考图片无法读取或超出限制。请重新上传 PNG、JPEG、WebP 或 GIF 图片，合计不超过 32 MiB。",
        en: "Reference images could not be read or exceed the limits. Upload PNG, JPEG, WebP or GIF images again, totaling at most 32 MiB.",
        ja: "参考画像を読み込めないか、上限を超えています。合計 32 MiB 以下の PNG、JPEG、WebP または GIF 画像を再アップロードしてください。",
        ko: "참고 이미지를 읽을 수 없거나 제한을 초과했습니다. 합계 32 MiB 이하의 PNG, JPEG, WebP 또는 GIF 이미지를 다시 업로드하세요.",
        ru: "Не удалось прочитать изображения либо превышен лимит. Загрузите PNG, JPEG, WebP или GIF повторно, общим размером не более 32 MiB.",
        fr: "Les images de référence sont illisibles ou dépassent les limites. Importez à nouveau des images PNG, JPEG, WebP ou GIF, pour un total maximal de 32 MiB.",
      },
    },
  );
}

const imageInput = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    aspect: z.enum(["square", "portrait", "landscape"]),
    quality: z.enum(["low", "medium", "high"]).optional(),
    referenceImages: z
      .array(z.union([z.string().regex(/^[a-f0-9]{64}$/u), flowImageSchema]))
      .max(MAX_REFERENCE_IMAGES)
      .optional(),
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
  /** Up to four asset IDs or admitted chat attachments, in prompt order. */
  referenceImages?: GptImageReference[];
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
      if (!parsed.success) throw invalidImageInput();
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
  private readonly artifacts: Pick<
    GeneratedArtifacts,
    "registerImage" | "readImage"
  >;
  private readonly readAttachment?: ReadImageAttachment;
  private readonly outputRoot: string;

  constructor(options: {
    request: CodexImageRequest;
    signedIn: () => Promise<boolean>;
    artifacts: Pick<GeneratedArtifacts, "registerImage" | "readImage">;
    readAttachment?: ReadImageAttachment;
    outputRoot: string;
  }) {
    this.request = options.request;
    this.signedIn = options.signedIn;
    this.artifacts = options.artifacts;
    this.readAttachment = options.readAttachment;
    this.outputRoot = options.outputRoot;
  }

  async available() {
    try {
      return await this.signedIn();
    } catch {
      return false;
    }
  }

  /** Resolve and validate locally before the single, non-retried Codex request. */
  private async referenceParts(
    references: readonly GptImageReference[],
    signal: AbortSignal,
  ) {
    const parts: Array<{
      type: "input_image";
      image_url: string;
      detail: "high";
    }> = [];
    let sourceBytes = 0;
    let normalizedBytes = 0;
    try {
      for (const reference of references) {
        signal.throwIfAborted();
        let bytes: Uint8Array;
        if (typeof reference === "string") {
          bytes = (await this.artifacts.readImage(reference, signal)).bytes;
        } else {
          if (!this.readAttachment) throw invalidImageReference();
          bytes = await this.readAttachment(reference, signal);
        }
        signal.throwIfAborted();
        sourceBytes += bytes.length;
        if (!bytes.length || sourceBytes > MAX_REFERENCE_BYTES)
          throw invalidImageReference();
        const image = sharp(bytes, {
          limitInputPixels: 40_000_000,
          failOn: "error",
        });
        const metadata = await image.metadata();
        if (
          !metadata.format ||
          !["png", "jpeg", "webp", "gif"].includes(metadata.format)
        )
          throw invalidImageReference();
        // Decode, auto-orient, strip metadata and flatten animations to frame 1.
        const normalized = await image.rotate().png().toBuffer();
        signal.throwIfAborted();
        normalizedBytes += normalized.length;
        if (normalizedBytes > MAX_REFERENCE_BYTES)
          throw invalidImageReference();
        parts.push({
          type: "input_image",
          image_url: `data:image/png;base64,${normalized.toString("base64")}`,
          detail: "high",
        });
      }
    } catch {
      signal.throwIfAborted();
      // Store failures can contain private paths; never expose their messages.
      throw invalidImageReference();
    }
    return parts;
  }

  async generate(
    input: GptImageInput,
    signal: AbortSignal,
  ): Promise<GptImageResult> {
    signal.throwIfAborted();
    const parsed = imageInput.safeParse(input);
    if (!parsed.success) throw invalidImageInput();
    input = parsed.data;
    const references = await this.referenceParts(
      input.referenceImages ?? [],
      signal,
    );
    signal.throwIfAborted();
    const { size, hint } = GPT_IMAGE_SIZES[input.aspect];
    const tool = {
      type: "image_generation",
      output_format: "png",
      size,
      ...(input.quality ? { quality: input.quality } : {}),
    };
    const body = {
      instructions:
        "Call the image_generation tool exactly once to create the image the user describes. Keep the requested orientation. Do not ask questions or add text." +
        (references.length
          ? " Use the supplied reference images in their given order to perform the requested edit or transformation."
          : ""),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `画幅：${hint}。\n${input.prompt}` },
            ...references,
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
