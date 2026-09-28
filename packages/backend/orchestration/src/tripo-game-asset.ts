import type { JsonValue } from "@aura/protocol/types";
import type { Context } from "@deepseek-ai/cordis";
import {
  TRIPO_GAME_ASSET_CAPABILITY,
  TripoGameAssetError,
  type TripoGameAssetRequest,
  type TripoGameAssetResult,
  type TripoPaidTaskJournal,
} from "@aura/tripo";
import { z } from "zod";
import { ActionFailure, type AuraCapabilityClient } from "./action-api.ts";
import type { GeneratedArtifacts } from "./generated-artifacts.ts";
import { TripoBudgetError, TripoBudgetJournal } from "./tripo-budget.ts";

const requestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_000),
    referenceImagePath: z.string().min(1).max(4_096).optional(),
    outputDirectory: z.string().min(1).max(4_096),
    useVeyaOutputDirectory: z.boolean().optional(),
    assetName: z.string().max(80).optional(),
    imageModel: z
      .enum(["chat_image_2.5_flare", "chat_image_2.5_sunburst"])
      .optional(),
    imageQuality: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    faceLimit: z.number().int().min(500).max(20_000).optional(),
    generationKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    referenceImage: z.object({ attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]), bytes: z.number().int().positive(),
      width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
  })
  .strict();

export interface TripoGameAssetPort {
  generateGameAsset(
    input: TripoGameAssetRequest,
    signal: AbortSignal,
    journal?: TripoPaidTaskJournal,
  ): Promise<TripoGameAssetResult>;
}

/** Credential-free Action capability for one bounded model-generation pipeline. */
export class TripoGameAssetCapability implements AuraCapabilityClient {
  readonly #tripo: TripoGameAssetPort;
  readonly artifacts?: GeneratedArtifacts;
  readonly defaultDirectory?: () => Promise<string | undefined>;
  readonly attachments?: Pick<Context["attachments"], "readImage">;
  readonly enforceBudget: boolean;

  constructor(
    tripo: TripoGameAssetPort,
    artifacts?: GeneratedArtifacts,
    defaultDirectory?: () => Promise<string | undefined>,
    attachments?: Pick<Context["attachments"], "readImage">,
    enforceBudget = false,
  ) {
    this.#tripo = tripo;
    this.artifacts = artifacts;
    this.defaultDirectory = defaultDirectory;
    this.attachments = attachments;
    this.enforceBudget = enforceBudget;
  }

  async invoke(
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (capability !== TRIPO_GAME_ASSET_CAPABILITY)
      throw new Error(`Aura host capability is unavailable: ${capability}`);
    if (operation !== "generate")
      throw new Error(`Unsupported Tripo game-asset operation: ${operation}`);
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new Error("Tripo game-asset input is invalid.");
    try {
      const { useVeyaOutputDirectory, referenceImage, generationKey, ...parsedRequest } = parsed.data;
      const request: TripoGameAssetRequest = parsedRequest;
      if (useVeyaOutputDirectory && this.defaultDirectory) {
        // Missing Veya sessions preserve standalone generation's legacy default;
        // a connected packaged Veya binds a writable creation-project root.
        const directory = await this.defaultDirectory().catch(() => undefined);
        if (directory) request.outputDirectory = directory;
      }
      if (referenceImage) {
        if (!this.attachments || request.referenceImagePath)
          throw new Error("Managed reference image is unavailable or conflicts with a file path.");
        const stored = await this.attachments.readImage(referenceImage as Parameters<Context["attachments"]["readImage"]>[0], signal);
        request.referenceImage = { bytes: stored.data, contentType: referenceImage.mediaType };
      }
      const journal = this.enforceBudget ? new TripoBudgetJournal(request.outputDirectory, {
        prompt: request.prompt, assetName: request.assetName, imageModel: request.imageModel,
        imageQuality: request.imageQuality, faceLimit: request.faceLimit,
        reference: referenceImage?.attachmentId ?? request.referenceImagePath,
      }, generationKey) : undefined;
      const result = await this.#tripo.generateGameAsset(request, signal, journal);
      // Preserve a completed paid result even if local registration fails. A
      // downstream import failure must not turn into another generation request.
      if (!this.artifacts) return result as unknown as JsonValue;
      try {
        return {
          ...result,
          modelArtifact: await this.artifacts.registerModel(
            result.modelPath,
            signal,
          ),
        } as unknown as JsonValue;
      } catch {
        signal.throwIfAborted();
        return {
          ...result,
          artifactRegistration: {
            status: "failed",
            code: "artifact_registration_failed",
            message:
              "Model generation completed and its files were retained. Local asset registration failed; do not regenerate or pay again.",
          },
        } as unknown as JsonValue;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TripoBudgetError)
        throw new ActionFailure(error.message, { cause: error });
      if (error instanceof TripoGameAssetError)
        throw new ActionFailure(error.message, { cause: error });
      throw new ActionFailure(
        "模型生成未完成 · 调用生成服务：服务发生未预期异常，请查看 Aura 后端日志后重试。",
        { cause: error },
      );
    }
  }
}
