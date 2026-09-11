import { defineFlow, z } from "@aura/orchestration/flow";
import { agentPrompt } from "./prompts.js";

export default defineFlow({
  title: "多角度分析 → 最终报告",
  description: "并行完成方案分析和风险审阅，再由 coordinator 汇总。",
  input: z.object({
    task: z.string().trim().min(1).max(12_000),
  }),
  output: z.object({
    report: z.string(),
  }),
  concurrency: 2,
  agentTimeoutMs: 180_000,

  async run(ctx, input) {
    const [research, review] = await Promise.all([
      ctx.agent({
        id: "research",
        label: "方案分析",
        preset: "researcher-v1",
        prompt: agentPrompt({
          task: input.task,
          nodeId: "research",
          instruction: "分析任务，给出可行方案、依据以及需要验证的假设。",
        }),
      }),
      ctx.agent({
        id: "review",
        label: "风险审阅",
        preset: "reviewer-v1",
        prompt: agentPrompt({
          task: input.task,
          nodeId: "review",
          instruction: "独立审视任务，列出风险、约束、反例和验收标准。",
        }),
      }),
    ]);

    const coordinator = await ctx.agent({
      id: "coordinator",
      label: "最终报告",
      preset: "coordinator-v1",
      prompt: agentPrompt({
        task: input.task,
        nodeId: "coordinator",
        instruction:
          "综合选定节点输出，生成含结论、分歧、风险和下一步的最终报告，并标注结论来源。",
        inputs: [
          { ...research, label: "方案分析" },
          { ...review, label: "风险审阅" },
        ],
      }),
    });

    if(coordinator.stepId > '100') {
      return {report: ''}
    }

    return { report: coordinator.output };
  },
});
