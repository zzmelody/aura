import type { Context } from "@deepseek-ai/cordis";
import type { JsonValue } from "@aura/protocol/types";
import { z } from "zod";
import sharp from "sharp";
import { ActionFailure, type AuraCapabilityClient } from "./action-api.ts";
import { TripoBudgetJournal, type CreationBudgetContext } from "./tripo-budget.ts";
import type { GeneratedArtifacts } from "./generated-artifacts.ts";

export const VEYA_CLOUD_IMAGE_CAPABILITY = "aura.veya.cloud-image";

const inputSchema = z.object({
  generationKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  prompt: z.string().trim().min(1).max(2_000),
  model: z.enum(["chat_image_2.5_flare", "chat_image_2.5_sunburst"]).default("chat_image_2.5_flare"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
}).strict();

export interface CloudImagePort {
  generateCloudImage(input: z.infer<typeof inputSchema>, signal: AbortSignal, journal?: { taskId?: string; submitted(taskId: string): Promise<void> }): Promise<{
    bytes: Uint8Array; taskId: string; creditsConsumed: number | null; actualModel: string | null;
  }>;
}

/** One paid sky-image request; no automatic submit retry or persistent quota. */
export class VeyaCloudImageCapability implements AuraCapabilityClient {
  readonly budgetContext?: (runId?: string) => Promise<CreationBudgetContext | undefined>;
  readonly projectRoot?: string;
  private readonly producer: CloudImagePort;
  private readonly artifacts: GeneratedArtifacts;
  private readonly attachments: Pick<Context["attachments"], "saveImage">;

  constructor(
    producer: CloudImagePort,
    artifacts: GeneratedArtifacts,
    attachments: Pick<Context["attachments"], "saveImage">,
    budgetContext?: (runId?: string) => Promise<CreationBudgetContext | undefined>,
    projectRoot?: string,
  ) {
    this.producer = producer;
    this.budgetContext = budgetContext;
    this.projectRoot = projectRoot;
    this.artifacts = artifacts;
    this.attachments = attachments;
  }

  async invoke(capability: string, operation: string, input: JsonValue, signal: AbortSignal, context?: { readonly runId?: string }): Promise<JsonValue> {
    if (capability !== VEYA_CLOUD_IMAGE_CAPABILITY || operation !== "generate")
      throw new Error("Unsupported Veya cloud-image capability operation.");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ActionFailure("invalid_cloud_image_request: Prompt/model/quality is invalid.");
    const { generationKey, ...request } = parsed.data;
    const creation = await this.budgetContext?.(context?.runId);
    const journal = creation || this.projectRoot ? new TripoBudgetJournal(`${creation?.projectRoot ?? this.projectRoot}/assets/generated`, request, generationKey, creation) : undefined;
    let generated = await journal?.loadCloud();
    if (!generated) {
      const known = await journal?.prepare("cloud", "cloud");
      try {
      generated = await this.producer.generateCloudImage(request, signal, journal ? { taskId: known, submitted: id => journal.submitted("cloud", id) } : undefined);
    } catch (error) {
      signal.throwIfAborted();
      throw new ActionFailure("cloud_image_result_unknown: A paid request may have started. Stop and reconcile; do not retry automatically.", { cause: error });
      }
      if (journal) {
        await journal.submitted("cloud", generated.taskId);
        await journal.saveCloud(generated.bytes, { taskId: generated.taskId, creditsConsumed: generated.creditsConsumed, actualModel: generated.actualModel });
        if (generated.creditsConsumed !== null) await journal.completed("cloud", generated.creditsConsumed);
      }
    }
    if (journal && generated.creditsConsumed === null)
      throw new ActionFailure("cloud_image_cost_unknown: Paid image retained; reconcile its actual cost before continuing.");
    const common = {
      prompt: parsed.data.prompt, requestedModel: parsed.data.model,
      actualModel: generated.actualModel, taskId: generated.taskId,
      creditsConsumed: generated.creditsConsumed,
    };
    try {
      const bytes = Buffer.from(generated.bytes);
      const metadata = await sharp(bytes, { limitInputPixels: 4_194_304, failOn: "error" }).metadata();
      if (metadata.format !== "png" || !metadata.width || metadata.width !== metadata.height ||
          metadata.width < 256 || metadata.width > 2048 || bytes.length > 8 * 1024 * 1024)
        return { status: "image_validation_failed", ...common, reason: "The generated cloud image is not a bounded square PNG." };
      const registered = await this.artifacts.registerImage(bytes, signal);
      if (registered.format !== "png")
        return { status: "artifact_registration_failed", ...common, reason: "The admitted artifact was not PNG." };
      const image = await this.attachments.saveImage({
        data: bytes, mediaType: "image/png", name: `veya-cloud-${registered.artifactId}.png`,
      });
      return { status: "ready", ...common, artifactId: registered.artifactId,
        sha256: registered.artifactId, bytes: bytes.length,
        width: metadata.width, height: metadata.height, image: image as unknown as JsonValue };
    } catch (error) {
      signal.throwIfAborted();
      return { status: "artifact_registration_failed", ...common,
        reason: "The paid image was generated but local admission failed; do not regenerate." };
    }
  }
}
