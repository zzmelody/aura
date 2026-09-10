import { useEffect, useState } from "react";

export const FLOW_DRAFT_KEY = "aura.flow-draft.v1";
export const starterFlow = `import { defineFlow, z } from "@aura/orchestration/flow";

export default defineFlow({
  title: "我的第一个 Flow",
  description: "分析任务，生成一份可执行的方案。",
  input: z.object({
    task: z.string().trim().min(1),
  }),
  output: z.object({ report: z.string() }),

  async run(ctx, input) {
    const result = await ctx.agent({
      id: "research",
      label: "方案分析",
      preset: "researcher-v1",
      prompt: input.task,
    });

    return { report: result.output };
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
  return `你是 Aura Flow 编写助手。根据用户需求生成或修改 Flow。返回完整的 javascript 代码块，可直接替换编辑器草稿。使用 import { defineFlow, z } from "@aura/orchestration/flow" 与 export default defineFlow({title, description, input: z.object(...), output: z.object(...), async run(ctx,input){...}})。ctx.agent({id,label,preset,prompt}) 返回 {stepId,sessionId,output:string}，可用 preset: researcher-v1、reviewer-v1、coordinator-v1。用 Promise.all 表达并行。不要声称已经部署或执行。当前编辑器的本地草稿${code.length > 9000 ? "（前 9000 字符，未包含全文）" : ""}：\n${code.slice(0, 9000)}`;
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
