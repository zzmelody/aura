import { defineAction } from "@aura/orchestration/action";
import { localAI } from "@aura/orchestration/local-ai";

export default defineAction({
  title: "本地视频生成",
  description:
    "使用本机 MiniMax H3 文生视频或首末帧图生视频（含音频，24 fps、8 步 Turbo）。自动启动并回收 ComfyUI，串行使用 GPU，返回视频文件路径。",
  parameters: {
    prompt: {
      type: "string",
      required: true,
      description: "视频及声音提示词，1–10000 字符。",
    },
    firstFrameAssetId: {
      type: "string",
      description:
        "可选的首帧图片资产 ID（64 位 SHA-256），由图片上传或 local-image 返回。",
    },
    lastFrameAssetId: {
      type: "string",
      description: "可选的末帧图片资产 ID（64 位 SHA-256）。",
    },
    referenceVideo: { type: "object", additionalProperties: true },
    referenceImages: { type: "array", items: { type: "string" } },
    width: {
      type: "integer",
      default: 608,
      description: "256–1312，32 的倍数；总像素不超过 736×1312。",
    },
    height: {
      type: "integer",
      default: 352,
      description: "256–1312，32 的倍数。",
    },
    frames: {
      type: "integer",
      default: 39,
      description: "目标帧数，12–720，24fps，内部自动分段和对齐。",
    },
    seed: { type: "integer", description: "0–2147483647；省略则随机。" },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string", required: true },
        seed: { type: "integer", required: true },
        files: { type: "array", items: { type: "string" }, required: true },
        videoPath: { type: "string" },
        segments: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 1800000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    return localAI(ctx).video(
      /** @type {import("@aura/orchestration/local-ai").VideoInput} */ (input),
      ctx.signal,
    );
  },
});
