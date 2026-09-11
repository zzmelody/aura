import { useEffect, useState } from "react";

export const FLOW_DRAFT_KEY = "aura.flow-draft.v1";
export const starterFlow = `import { defineFlow, z } from "@aura/orchestration/flow";

export default defineFlow({
  title: "我的第一个 Flow",
  description: "并行分析任务，并按复杂度决定是否综合结论。",
  input: z.object({
    task: z.string().trim().min(1),
  }),
  output: z.object({ report: z.string() }),

  async run(ctx, input) {
    const [research, review] = await Promise.all([
      ctx.agent({
        id: "research",
        label: "调研方案",
        preset: "researcher-v1",
        prompt: input.task,
      }),
      ctx.agent({
        id: "review",
        label: "评估风险",
        preset: "reviewer-v1",
        prompt: input.task,
      }),
    ]);

    let report = research.output + "\\n\\n" + review.output;
    if (input.task.length > 80) {
      const coordinator = await ctx.agent({
        id: "coordinate",
        label: "综合结论",
        preset: "coordinator-v1",
        prompt: report,
      });
      report = coordinator.output;
    }

    return { report };
  },
});
`;

/** Only complete, explicitly marked Flow code blocks can replace a draft. */
export function extractFlowCode(text: string): string | undefined {
  const blocks = [
    ...text.matchAll(
      /```(?:javascript|js|typescript|ts)?[ \t]*\r?\n([\s\S]*?)```/g,
    ),
  ];
  return blocks
    .reverse()
    .map((match) => match[1].trim())
    .find(
      (code) =>
        /\bdefineFlow\s*\(/.test(code) && /\bexport\s+default\b/.test(code),
    );
}

export function flowContext(code: string): string {
  return `你是 Aura Flow 编写助手。根据用户需求生成或修改 Flow。返回完整的 javascript 代码块，可直接替换编辑器草稿。使用 import { defineFlow, z } from "@aura/orchestration/flow" 与 export default defineFlow({title, description, input: z.object(...), output: z.object(...), async run(ctx,input){...}})。ctx.agent({id,label,preset,prompt}) 返回 {stepId,sessionId,output:string}，可用 preset: researcher-v1、reviewer-v1、coordinator-v1；直接调用 Action 时使用 ctx.action({id,label,action,input})。用 Promise.all 表达并行。前端只会把 input、output、ctx.agent、ctx.action/工具调用、if/switch 和循环解析为流程图节点，变量处理、格式化、日志及辅助函数仍可正常编写，但不会显示为节点。不要声称已经部署或执行。当前编辑器的本地草稿${code.length > 9000 ? "（前 9000 字符，未包含全文）" : ""}：\n${code.slice(0, 9000)}`;
}

export function useFlowDraft() {
  const [initial] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(FLOW_DRAFT_KEY) ?? "null");
      return {
        code:
          value?.version === 1 && typeof value.code === "string"
            ? value.code
            : starterFlow,
        error: "",
      };
    } catch {
      return {
        code: starterFlow,
        error: "无法读取本地草稿，可编辑后导出保存。",
      };
    }
  });
  const [code, setCode] = useState<string>(initial.code);
  const [previous, setPrevious] = useState<string>();
  const [saveError, setSaveError] = useState(initial.error);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    setSaved(false);
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          FLOW_DRAFT_KEY,
          JSON.stringify({ version: 1, code }),
        );
        setSaveError("");
        setSaved(true);
      } catch {
        setSaveError("本地草稿保存失败，请导出文件保存。 ");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [code]);
  return {
    code,
    saved,
    saveError,
    edit: setCode,
    update: (next: string) => {
      setPrevious(code);
      setCode(next);
    },
    canUndo: previous !== undefined,
    undo: () => {
      if (previous !== undefined) {
        setCode(previous);
        setPrevious(undefined);
      }
    },
  };
}
export type FlowDraftController = ReturnType<typeof useFlowDraft>;
