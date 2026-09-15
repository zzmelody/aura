import { defineAction } from "@aura/orchestration/action";
import { localAI } from "@aura/orchestration/local-ai";

export default defineAction({
  title: "本地图片生成",
  description:
    "使用本机 Qwen-Image-2512 生成 PNG。自动启动并回收 ComfyUI，串行使用 GPU，结果返回本地文件路径。",
  parameters: {
    prompt: {
      type: "string",
      required: true,
      description: "图片提示词，1–10000 字符。",
    },
    negative: { type: "string", description: "负面提示词。" },
    width: {
      type: "integer",
      default: 1024,
      description: "256–1536，16 的倍数；总像素不超过 1328×1328。",
    },
    height: {
      type: "integer",
      default: 1024,
      description: "256–1536，16 的倍数。",
    },
    steps: { type: "integer", default: 30, description: "采样步数 1–50。" },
    cfg: { type: "number", default: 4, description: "引导强度 1–10。" },
    seed: {
      type: "integer",
      description: "0–2147483647；省略则随机，结果中返回。",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string", required: true },
        seed: { type: "integer", required: true },
        files: { type: "array", items: { type: "string" }, required: true },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 600_000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    return localAI(ctx).image(input, ctx.signal);
  },
});
