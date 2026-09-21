import type { JsonValue } from "@aura/protocol/types";
import {
  TRIPO_GAME_ASSET_CAPABILITY,
  type TripoGameAssetRequest,
  type TripoGameAssetResult,
} from "@aura/tripo";
import { z } from "zod";
import type { AuraCapabilityClient } from "./action-api.ts";

const requestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_000),
    referenceImagePath: z.string().min(1).max(4_096).optional(),
    outputDirectory: z.string().min(1).max(4_096),
    assetName: z.string().max(80).optional(),
    imageModel: z
      .enum(["chat_image_2.5_flare", "chat_image_2.5_sunburst"])
      .optional(),
    imageQuality: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    faceLimit: z.number().int().min(500).max(20_000).optional(),
  })
  .strict();

export interface TripoGameAssetPort {
  generateGameAsset(
    input: TripoGameAssetRequest,
    signal: AbortSignal,
  ): Promise<TripoGameAssetResult>;
}

/** Credential-free Action capability for one bounded model-generation pipeline. */
export class TripoGameAssetCapability implements AuraCapabilityClient {
  readonly #tripo: TripoGameAssetPort;

  constructor(tripo: TripoGameAssetPort) {
    this.#tripo = tripo;
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
    return (await this.#tripo.generateGameAsset(
      parsed.data,
      signal,
    )) as unknown as JsonValue;
  }
}
