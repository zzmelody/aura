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
    return ctx.sequence({ id: "main" }, async (flow) => {
    const { research, review } = await flow.parallel({ id: "analysis", branches: {
      research: (branch) => branch.agent({
        id: "research",
        label: "调研方案",
        preset: "researcher-v1",
        prompt: input.task,
      }),
      review: (branch) => branch.agent({
        id: "review",
        label: "评估风险",
        preset: "reviewer-v1",
        prompt: input.task,
      }),
    }});

    let report = research.output + "\\n\\n" + review.output;
    if (input.task.length > 80) {
      const coordinator = await flow.agent({
        id: "coordinate",
        label: "综合结论",
        preset: "coordinator-v1",
        prompt: report,
      });
      report = coordinator.output;
    }

    return { report };
    });
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
  return `你是 Aura Flow 编写助手。根据用户需求生成或修改 Flow。返回完整的 javascript 代码块。使用 import { defineFlow, z } from "@aura/orchestration/flow" 和 export default defineFlow({title, description, input, output, async run(ctx,input){ return ctx.sequence({id:"main"}, async flow => {...}); }})。根 ctx 只提供 sequence。作用域内每个调用必须 await 或 return；同级 id 唯一，循环使用稳定业务键创建 sequence。flow.agent({id,label,preset,prompt,actions?,retry?}) 返回 {stepId,sessionId,output:string}，preset 可用 researcher-v1、reviewer-v1、coordinator-v1；flow.action({id,label?,action,input,retry?}) 返回 {stepId,actionId,output}。并行统一用 flow.parallel({id,branches:{research: branch => branch.agent({...}),review: branch => branch.agent({...})}})，返回同键结果对象，禁止 Promise.all/race。重试默认 maxAttempts:1，可声明 retry:{maxAttempts:3,initialDelayMs:1000,multiplier:2,maxDelayMs:30000}，只有 idempotent Action 支持自动重试。flow.memo({id,schema:z...,compute:()=>JSON值}) 保存只读计算或随机结果，外部写入必须通过 Action。flow.checkpoint({id,label?,prompt,schema:z...}) 等待人工 JSON 输入，禁止在 parallel 分支内调用。恢复时普通代码会从入口重放，已完成 durable 调用复用输出；不要把外部副作用写在普通代码里。静态图是只读投影，条件和循环仍用原生 JS。不要声称已经部署或执行。当前本地草稿${code.length > 9000 ? "（前 9000 字符）" : ""}：\n${code.slice(0, 9000)}`;
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
