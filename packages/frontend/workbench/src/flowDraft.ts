import { useEffect, useState } from "react";
import { flowAnalysisInstructions } from "./flow-analysis.ts";
import {
  useWorkflowMessages,
  type WorkflowMessageKey,
} from "./workflow-messages.ts";

export const FLOW_DRAFT_KEY = "aura.flow-draft.v1";
export const starterFlow = `import { defineFlow, z } from "@aura/orchestration/flow";

export default defineFlow({
  title: "我的第一个 Flow",
  description: "并行分析任务，并按复杂度决定是否综合结论。",
  input: z.object({
    task: z.string().trim().min(1),
  }),
  output: z.object({ report: z.string() }),
  agentDefaults: { timeoutMs: 180000 },

  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
    const { research, review } = await flow.parallel({ id: "analysis", branches: {
      research: (branch) => branch.agent({
        id: "research",
        label: "调研方案",
        preset: "researcher-v1",
        reasoningEffort: ctx.mode === "codex" ? "medium" : "off",
        prompt: input.task,
      }),
      review: (branch) => branch.agent({
        id: "review",
        label: "评估风险",
        preset: "reviewer-v1",
        reasoningEffort: ctx.mode === "codex" ? "high" : "off",
        prompt: input.task,
      }),
    }});

    let report = research.output + "\\n\\n" + review.output;
    if (input.task.length > 80) {
      const coordinator = await flow.agent({
        id: "coordinate",
        label: "综合结论",
        preset: "coordinator-v1",
        reasoningEffort: ctx.mode === "codex" ? "high" : "off",
        timeoutMs: 240000,
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

export function flowContext(code: string, analysisId?: string): string {
  const limit = analysisId ? 7000 : 9000;
  return `你是 Aura Flow 编写助手。根据用户需求分析、生成或修改 Flow。修改时返回完整的 javascript 代码块。使用 import { defineFlow, z } from "@aura/orchestration/flow" 和 export default defineFlow({title, description, input, output, async run(ctx,input){ return ctx.sequence({id:"main"}, async flow => {...}); }})。用户明确要求让其他应用通过 HTTP 调用时，在 defineFlow 中设置 service:true；否则不要公开为服务。根 ctx 只提供 sequence。作用域内每个调用必须 await 或 return；同级 id 唯一，循环使用稳定业务键创建 sequence。flow.agent({id,label,preset,prompt,actions?,retry?,model?,reasoningEffort?,maxTokens?,temperature?,timeoutMs?}) 返回 {stepId,sessionId,output:string}，preset 可用 researcher-v1、reviewer-v1、coordinator-v1；flow.action({id,label?,action,input,retry?}) 返回 {stepId,actionId,output}；flow.flow({id,label?,flow,input}) 用规范 Flow ID 调用子工作流并返回 {stepId,runId,flowId,output}，禁止用 Action 包装宿主入口模拟嵌套。defineFlow 可设 agentDefaults:{model?,reasoningEffort?,maxTokens?,temperature?,timeoutMs?}；优先级为步骤覆盖 Flow 默认再覆盖运行时默认。model 为当前模式 provider 下的模型 ID，不接受 provider/apiKey/baseURL。reasoningEffort 使用 DSH 对该模型支持的准确档位，不擅自承诺任意档位可用。Codex 默认模型 gpt-6.1-sol、思考强度 xhigh（Extra high），Demo 仅支持 off；同一 Flow 同时用于两种模式时，可写 ctx.mode === "codex" ? "high" : "off"。temperature 为 0–2，由模型决定是否接受；timeoutMs 为 1000–600000。maxTokens 为正整数，但当前 Codex 适配器不支持，Codex 下禁止设置；Demo 可配置。最终配置随 Run/步骤存档，重试恢复不读取新环境默认值。并行统一用 flow.parallel({id,branches:{research: branch => branch.agent({...}),review: branch => branch.agent({...})}})，返回同键结果对象，禁止 Promise.all/race。重试默认 maxAttempts:1，可声明 retry:{maxAttempts:3,initialDelayMs:1000,multiplier:2,maxDelayMs:30000}，只有 idempotent Action 支持自动重试。flow.memo({id,schema:z...,compute:()=>JSON值}) 保存只读计算或随机结果，外部写入必须通过 Action。flow.checkpoint({id,label?,prompt,schema:z...}) 等待人工 JSON 输入，禁止在 parallel 分支内调用。恢复时普通代码会从入口重放，已完成 durable 调用复用输出；不要把外部副作用写在普通代码里。条件和循环仍用原生 JS。不要声称已经部署或执行。${analysisId ? flowAnalysisInstructions(analysisId) : ""}当前流程${code.length > limit ? `（前 ${limit} 字符，源码已截断；请说明分析范围，不要返回替换代码）` : ""}：\n${code.slice(0, limit)}`;
}

export function useFlowDraft() {
  const { t } = useWorkflowMessages();
  const [initial] = useState<{ code: string; error?: WorkflowMessageKey }>(
    () => {
      try {
        const value = JSON.parse(
          localStorage.getItem(FLOW_DRAFT_KEY) ?? "null",
        );
        return {
          code:
            value?.version === 1 && typeof value.code === "string"
              ? value.code
              : starterFlow,
        };
      } catch {
        return {
          code: starterFlow,
          error: "draftReadFailed",
        };
      }
    },
  );
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
        setSaveError(undefined);
        setSaved(true);
      } catch {
        setSaveError("draftSaveFailed");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [code]);
  return {
    code,
    saved,
    saveError: saveError ? t(saveError) : "",
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
