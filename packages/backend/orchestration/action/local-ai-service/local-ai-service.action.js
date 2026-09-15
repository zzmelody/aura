import { defineAction } from "@aura/orchestration/action";
import { localAI } from "@aura/orchestration/local-ai";

export default defineAction({
  title: "本地 AI 服务",
  description:
    "查看、启动或停止 Aura 管理的本地模型服务。启动后空闲 60 秒自动停止；不接管或终止外部进程。生成 Action 自带启停，通常无需提前启动。",
  parameters: {
    service: {
      type: "string",
      enum: ["qwen-image", "minimax-h3", "qwen3-tts"],
      required: true,
    },
    operation: {
      type: "string",
      enum: ["status", "start", "stop"],
      required: true,
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string", required: true },
        state: { type: "string", required: true },
        url: { type: "string", required: true },
        managed: { type: "boolean", required: true },
        idleTimeoutMs: { type: "integer", required: true },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 600_000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    return localAI(ctx).service(input.service, input.operation, ctx.signal);
  },
});
