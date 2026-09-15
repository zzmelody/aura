import { defineFlow, z } from "@aura/orchestration/flow";

export default defineFlow({
  title: "Action 调用示例",
  description: "先直接统计文本，再将同一个 Action 提供给 Agent 按需使用。",
  input: z.object({ text: z.string().min(1) }),
  output: z.object({ statistics: z.json(), report: z.string() }),
  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
      const statistics = await flow.action({
        id: "statistics",
        action: "text-stats",
        input: { text: input.text },
      });
      const agent = await flow.agent({
        id: "review",
        label: "内容审阅",
        preset: "reviewer-v1",
        actions: ["text-stats"],
        prompt: `请审阅以下文本，可按需调用 text-stats 工具复核统计。\n文本：${input.text}\n统计：${JSON.stringify(statistics.output)}`,
      });
      return { statistics: statistics.output, report: agent.output };
    });
  },
});
