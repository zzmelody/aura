import { defineFlow, z } from "@aura/orchestration/flow";

/** @param {import("@aura/protocol/types").JsonValue} value */
function generated(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.files) ||
    typeof value.files[0] !== "string"
  )
    throw new Error("图片生成没有返回可用的图片文件。");
  return {
    imagePath: value.files[0],
    engine: String(value.engine ?? "local"),
    model: String(value.model ?? ""),
    ...(typeof value.imageAssetId === "string"
      ? { imageAssetId: value.imageAssetId }
      : {}),
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(typeof value.fallbackReason === "string"
      ? { note: value.fallbackReason }
      : {}),
  };
}

export default defineFlow({
  title: "图片生成",
  description:
    "按提示词生成一张图片。优先使用 GPT 图片生成（Codex 订阅），未登录时改用本机图片模型；可选方图、竖图或横图。",
  input: z.object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("画面描述：主体、场景、风格、光线与构图。"),
    aspect: z
      .enum(["square", "portrait", "landscape"])
      .default("square")
      .describe("画幅：square 方图，portrait 竖图，landscape 横图。"),
    engine: z
      .enum(["auto", "gpt", "local"])
      .default("auto")
      .describe("auto 优先 GPT（Codex 订阅）；gpt 只用 GPT；local 只用本机模型。"),
    quality: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("可选。GPT 的质量档位，省略时由 Codex 决定。"),
    negative: z
      .string()
      .trim()
      .max(1_000)
      .optional()
      .describe("可选。不希望出现的内容（仅本机模型使用）。"),
  }),
  output: z.object({
    imagePath: z.string(),
    engine: z.string(),
    model: z.string(),
    imageAssetId: z.string().optional(),
    seed: z.number().optional(),
    note: z.string().optional(),
  }),
  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
      const image = await flow.action({
        id: "image",
        label: "生成图片",
        action: "image-generate",
        input: {
          prompt: input.prompt,
          aspect: input.aspect,
          engine: input.engine,
          ...(input.quality ? { quality: input.quality } : {}),
          ...(input.negative ? { negative: input.negative } : {}),
        },
      });
      return generated(image.output);
    });
  },
});
