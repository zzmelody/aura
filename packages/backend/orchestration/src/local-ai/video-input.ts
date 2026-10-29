import { randomInt } from "node:crypto";
import { z } from "zod";

const assetId = z.string().regex(/^[a-f0-9]{64}$/u);
export const videoInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(10000),
    firstFrameAssetId: assetId.optional(),
    lastFrameAssetId: assetId.optional(),
    referenceVideo: z
      .object({
        assetId,
        start: z.number().min(0).max(36000),
        duration: z.number().min(0.5).max(15),
        role: z.string().max(1000),
        audio: z.boolean(),
      })
      .strict()
      .optional(),
    referenceImages: z.array(assetId).max(8).optional(),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .default(() => randomInt(2147483647)),
    width: z.number().int().min(256).max(1312).multipleOf(32).default(608),
    height: z.number().int().min(256).max(1312).multipleOf(32).default(352),
    frames: z.number().int().min(12).max(720).default(39),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.width * value.height > 736 * 1312)
      ctx.addIssue({
        code: "custom",
        message: "视频总像素不能超过 736×1312。",
      });
    if (
      (value.referenceVideo || value.referenceImages?.length) &&
      (value.firstFrameAssetId || value.lastFrameAssetId)
    )
      ctx.addIssue({
        code: "custom",
        message: "视频/角色参考与首末帧模式不能同时使用。",
      });
  });
