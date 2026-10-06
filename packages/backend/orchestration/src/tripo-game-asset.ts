import { isAbsolute, join } from "node:path";
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

const scopeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
  noNewPaidWork: z.boolean().optional(),
}).strict();

const modelSchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  /** Trusted local reference file; mutually exclusive with referenceImage. */
  referenceImagePath: z.string().min(1).max(4_096).refine(isAbsolute).optional(),
  /** Absolute directory for the published files; defaults to Aura's managed model store. */
  outputDirectory: z.string().min(1).max(4_096).refine(isAbsolute).optional(),
  assetName: z.string().max(80).optional(),
  imageModel: z.enum(["chat_image_2.5_flare", "chat_image_2.5_sunburst"]).optional(),
  imageQuality: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  faceLimit: z.number().int().min(500).max(20_000).optional(),
  generationKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  scope: scopeSchema.optional(),
  referenceImage: z.object({ attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]), bytes: z.number().int().positive(),
    width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
}).strict();

const imageSchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  model: z.enum(["chat_image_2.5_flare", "chat_image_2.5_sunburst"]).default("chat_image_2.5_flare"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  generationKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  scope: scopeSchema.optional(),
  /** Also admit the image as a session attachment so a Flow Agent can review it. */
  attach: z.boolean().optional(),
}).strict();

const ledgerSchema = z.object({ scope: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u) }).strict();

export interface TripoGameAssetPort {
  generateGameAsset(input: TripoGameAssetRequest, signal: AbortSignal, journal?: TripoPaidTaskJournal): Promise<TripoGameAssetResult>;
  generateCloudImage?(
    input: { prompt: string; model: "chat_image_2.5_flare" | "chat_image_2.5_sunburst"; quality: "low" | "medium" | "high" },
    signal: AbortSignal,
    journal?: { taskId?: string; submitted(taskId: string): Promise<void> },
  ): Promise<{ bytes: Uint8Array; taskId: string; creditsConsumed: number | null; actualModel: string | null }>;
}

/**
 * Credential-free Tripo port for plugin Actions: one four-view-to-GLB model
 * chain, one image request, and a read-only ledger view. Every paid stage is
 * reserved in the user-owned ledger before submission; `scope` groups work for
 * per-scope ceilings and `noNewPaidWork` reuses retained results only.
 */
export class TripoGameAssetCapability implements AuraCapabilityClient {
  readonly #tripo: TripoGameAssetPort;
  readonly #ledger: string;
  readonly #artifacts?: Pick<GeneratedArtifacts, "registerModel" | "put">;
  readonly #attachments?: Pick<Context["attachments"], "readImage">;
  readonly #saveImage?: Context["attachments"]["saveImage"];

  constructor(options: {
    tripo: TripoGameAssetPort;
    /** Directory holding budget.json and the paid ledger. */
    ledgerDirectory: string;
    artifacts?: Pick<GeneratedArtifacts, "registerModel" | "put">;
    attachments?: Pick<Context["attachments"], "readImage" | "saveImage">;
  }) {
    this.#tripo = options.tripo;
    this.#ledger = options.ledgerDirectory;
    this.#artifacts = options.artifacts;
    this.#attachments = options.attachments;
    this.#saveImage = options.attachments?.saveImage?.bind(options.attachments);
  }

  async invoke(capability: string, operation: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    if (capability !== TRIPO_GAME_ASSET_CAPABILITY)
      throw new Error(`Aura host capability is unavailable: ${capability}`);
    try {
      if (operation === "generate") return await this.#model(input, signal);
      if (operation === "image") return await this.#image(input, signal);
      if (operation === "ledger") {
        const parsed = ledgerSchema.safeParse(input);
        if (!parsed.success) throw new ActionFailure("invalid_tripo_request: ledger needs a scope.");
        return await TripoBudgetJournal.scopeLedger(this.#ledger, parsed.data.scope) as unknown as JsonValue;
      }
      throw new ActionFailure(`unsupported_operation: Tripo has no ${operation}.`);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ActionFailure) throw error;
      if (error instanceof TripoBudgetError || error instanceof TripoGameAssetError)
        throw new ActionFailure(error.message, { cause: error });
      throw new ActionFailure("模型生成未完成 · 调用生成服务：服务发生未预期异常，请查看 Aura 后端日志后重试。", { cause: error });
    }
  }

  async #model(input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const parsed = modelSchema.safeParse(input);
    if (!parsed.success) throw new ActionFailure("invalid_tripo_request: Tripo model input is invalid.");
    const { referenceImage, generationKey, scope, ...fields } = parsed.data;
    if (referenceImage && fields.referenceImagePath)
      throw new ActionFailure("invalid_tripo_request: Choose one reference image source.");
    const request: TripoGameAssetRequest = { ...fields, outputDirectory: fields.outputDirectory ?? join(this.#ledger, "models") };
    if (referenceImage) {
      if (!this.#attachments) throw new ActionFailure("invalid_tripo_request: Managed reference images are unavailable.");
      const stored = await this.#attachments.readImage(referenceImage as Parameters<Context["attachments"]["readImage"]>[0], signal);
      request.referenceImage = { bytes: stored.data, contentType: referenceImage.mediaType };
    }
    const journal = new TripoBudgetJournal(this.#ledger, {
      prompt: request.prompt, assetName: request.assetName, imageModel: request.imageModel,
      imageQuality: request.imageQuality, faceLimit: request.faceLimit,
      reference: referenceImage?.attachmentId ?? request.referenceImagePath,
    }, generationKey, scope);
    const result = await this.#tripo.generateGameAsset(request, signal, journal);
    const paid = {
      taskIds: result.taskIds, creditsConsumed: result.creditsConsumed,
      imageModel: result.imageModel, modelVersion: result.modelVersion, faceLimit: result.faceLimit,
    };
    // A completed paid result is never lost to a local registration failure.
    if (!this.#artifacts) return paid as unknown as JsonValue;
    try {
      return { ...paid, modelArtifact: await this.#artifacts.registerModel(result.modelPath, signal) } as unknown as JsonValue;
    } catch {
      signal.throwIfAborted();
      return { ...paid, artifactRegistration: { status: "failed", code: "artifact_registration_failed",
        message: "Model generation completed and its files were retained. Local asset registration failed; do not regenerate or pay again." } } as unknown as JsonValue;
    }
  }

  async #image(input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const parsed = imageSchema.safeParse(input);
    if (!parsed.success) throw new ActionFailure("invalid_tripo_request: Prompt/model/quality is invalid.");
    if (!this.#tripo.generateCloudImage || !this.#artifacts)
      throw new ActionFailure("tripo_image_unavailable: Tripo image generation is not configured.");
    const { generationKey, scope, attach, ...request } = parsed.data;
    const journal = new TripoBudgetJournal(this.#ledger, request, generationKey, scope);
    let generated = await journal.loadCloud();
    if (!generated) {
      const known = await journal.prepare("cloud", "cloud");
      try {
        generated = await this.#tripo.generateCloudImage(request, signal, { taskId: known, submitted: (id) => journal.submitted("cloud", id) });
      } catch (error) {
        signal.throwIfAborted();
        throw new ActionFailure("tripo_image_result_unknown: A paid request may have started. Stop and reconcile; do not retry automatically.", { cause: error });
      }
      await journal.submitted("cloud", generated.taskId);
      await journal.saveCloud(generated.bytes, { taskId: generated.taskId, creditsConsumed: generated.creditsConsumed, actualModel: generated.actualModel });
      if (generated.creditsConsumed !== null) await journal.completed("cloud", generated.creditsConsumed);
    }
    const paid = { taskId: generated.taskId, creditsConsumed: generated.creditsConsumed, actualModel: generated.actualModel };
    if (generated.creditsConsumed === null)
      throw new ActionFailure("tripo_image_cost_unknown: Paid image retained; reconcile its actual cost before continuing.");
    try {
      const stored = await this.#artifacts.put(generated.bytes, signal);
      const image = attach && this.#saveImage && stored.mimeType.startsWith("image/")
        ? await this.#saveImage({ data: generated.bytes, mediaType: stored.mimeType as "image/png", name: `tripo-${stored.artifactId}.${stored.format}` })
        : undefined;
      return { status: "ready", ...paid, artifactId: stored.artifactId, mimeType: stored.mimeType, bytes: stored.bytes,
        ...(stored.width ? { width: stored.width } : {}), ...(stored.height ? { height: stored.height } : {}),
        ...(image ? { image: image as unknown as JsonValue } : {}) };
    } catch {
      signal.throwIfAborted();
      return { status: "artifact_registration_failed", ...paid,
        reason: "The paid image was generated but local admission failed; do not regenerate." };
    }
  }
}
