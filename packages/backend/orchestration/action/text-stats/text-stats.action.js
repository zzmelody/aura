import { defineAction } from "@aura/orchestration/action";

export default defineAction({
  title: "文本统计",
  description: "统计给定文本的字符数和非空行数。",
  parameters: { text: { type: "string", required: true } },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        characters: { type: "integer", required: true },
        lines: { type: "integer", required: true },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 5_000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    ctx.signal.throwIfAborted();
    return {
      characters: Array.from(input.text).length,
      lines: input.text.split(/\r?\n/).filter((line) => line.trim()).length,
    };
  },
});
