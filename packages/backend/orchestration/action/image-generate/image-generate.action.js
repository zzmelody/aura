import { defineAction } from "@aura/orchestration/action";
import { localAI } from "@aura/orchestration/local-ai";

/** Local Qwen-Image pixel sizes within its 1328² budget. */
const LOCAL_SIZES = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 864, height: 1152 },
  landscape: { width: 1152, height: 864 },
};

export default defineAction({
  title: "图片生成",
  description:
    "按提示词生成一张图片。默认优先使用 GPT 图片生成（经已登录的 Codex 订阅，消耗订阅额度），未登录时自动改用本机 Qwen-Image。返回文件路径、图片资产 ID 和实际使用的引擎。",
  parameters: {
    prompt: {
      type: "string",
      required: true,
      description: "画面描述，1–2000 字。",
    },
    aspect: {
      type: "string",
      enum: ["square", "portrait", "landscape"],
      default: "square",
      description: "画幅：方图、竖图或横图。",
    },
    engine: {
      type: "string",
      enum: ["auto", "gpt", "local"],
      default: "auto",
      description:
        "auto 优先 GPT（Codex 订阅），不可用时用本机模型；gpt 只用 GPT；local 只用本机。",
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "仅 GPT 使用；省略时由 Codex 决定。",
    },
    negative: {
      type: "string",
      description: "不希望出现的内容；仅本机模型使用。",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        engine: { type: "string", required: true },
        model: { type: "string", required: true },
        files: { type: "array", items: { type: "string" }, required: true },
        imageAssetId: { type: "string" },
        seed: { type: "integer" },
        revisedPrompt: { type: "string" },
        fallbackReason: { type: "string" },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 1800000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    const aspect = input.aspect ?? "square";
    const engine = input.engine ?? "auto";
    const gpt = ctx.gptImage;
    if (engine !== "local" && gpt && (await gpt.available())) {
      // A failed or unknown GPT result surfaces as an error; it is never
      // silently regenerated on another engine.
      const result = await gpt.generate(
        {
          prompt: input.prompt,
          aspect,
          ...(input.quality ? { quality: input.quality } : {}),
        },
        ctx.signal,
      );
      return {
        engine: "gpt",
        model: result.model,
        files: result.files,
        imageAssetId: result.imageAssetId,
        ...(result.revisedPrompt
          ? { revisedPrompt: result.revisedPrompt }
          : {}),
      };
    }
    if (engine === "gpt")
      throw new Error("GPT 图片生成不可用：请先在右上角登录 Codex。");
    const local = await localAI(ctx).image(
      {
        prompt: input.prompt,
        ...LOCAL_SIZES[aspect],
        ...(input.negative ? { negative: input.negative } : {}),
      },
      ctx.signal,
    );
    return {
      engine: "local",
      model: "qwen-image",
      files: local.files,
      ...(local.imageAssetId ? { imageAssetId: local.imageAssetId } : {}),
      seed: local.seed,
      ...(engine === "auto"
        ? { fallbackReason: "未登录 Codex，已使用本机图片模型。" }
        : {}),
    };
  },
});
