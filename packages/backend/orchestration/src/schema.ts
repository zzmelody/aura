import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(12000);
const refs = z
  .array(id)
  .max(16)
  .refine((v) => new Set(v).size === v.length, "不能重复引用节点");
export const definitionSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(100),
    nodes: z
      .array(
        z
          .object({
            id: id.refine(
              (v) => v !== "coordinator",
              "coordinator 是保留的步骤 ID",
            ),
            label: z.string().trim().min(1).max(100),
            preset: id,
            prompt: text,
            dependsOn: refs.default([]),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    coordinator: z
      .object({ preset: id, prompt: text, sources: refs.min(1) })
      .strict(),
    concurrency: z.number().int().min(1).max(4).default(2),
    timeoutMs: z.number().int().min(1000).max(600000).default(180000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodes = new Map(value.nodes.map((node) => [node.id, node]));
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (nodes.size !== value.nodes.length) invalid("节点 ID 不能重复");
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) {
        invalid("流程不能包含循环依赖");
        return;
      }
      if (visited.has(key)) return;
      if (!nodes.has(key)) {
        invalid(`引用的节点不存在：${key}`);
        return;
      }
      visiting.add(key);
      for (const dep of nodes.get(key)!.dependsOn) visit(dep);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of nodes.keys()) visit(key);
    for (const key of value.coordinator.sources)
      if (!nodes.has(key)) invalid(`汇总来源不存在：${key}`);
  });

export const startSchema = z
  .object({
    requestId: z.uuid(),
    definitionId: id,
    task: text,
    mode: z.enum(["demo", "codex"]),
  })
  .strict();
export const phaseSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
export const stepSchema = z.object({
  id,
  label: z.string(),
  preset: id,
  sessionId: z.uuid(),
  status: phaseSchema,
  output: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
});
export const runSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  definition: definitionSchema,
  revision: z.number().int(),
  task: text,
  mode: z.enum(["demo", "codex"]),
  status: phaseSchema,
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  steps: z.array(stepSchema),
  report: z.string().optional(),
  error: z.string().optional(),
});
export const savedSchema = z.object({
  definition: definitionSchema,
  revision: z.number().int(),
  updatedAt: z.number(),
});
export const active = (status: string) =>
  status === "queued" || status === "running";
export class FlowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new FlowError(
      result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；"),
    );
  return result.data;
}

export const defaultDefinition = definitionSchema.parse({
  id: "research-report",
  name: "多角度分析 → 最终报告",
  nodes: [
    {
      id: "research",
      label: "方案分析",
      preset: "researcher-v1",
      prompt: "分析任务，给出可行方案、依据以及需要验证的假设。",
    },
    {
      id: "review",
      label: "风险审阅",
      preset: "reviewer-v1",
      prompt: "独立审视任务，列出风险、约束、反例和验收标准。",
    },
  ],
  coordinator: {
    preset: "coordinator-v1",
    sources: ["research", "review"],
    prompt:
      "综合选定节点的输出，生成含结论、分歧、风险和下一步的最终报告。标注每个结论来自哪个节点，不要伪造验证或来源。",
  },
});

export function buildInput(
  run: { task: string },
  step: { id: string; prompt: string },
  nodes: import("@aura/protocol/types").FlowStep[],
) {
  const payload = {
    task: run.task,
    nodeId: step.id,
    instruction: step.prompt,
    inputs: nodes.map((node) => ({
      nodeId: node.id,
      label: node.label,
      sessionId: node.sessionId,
      output: node.output,
    })),
  };
  const input = "AURA_FLOW_INPUT_V1\n" + JSON.stringify(payload);
  if (input.length > 180000)
    throw new FlowError("节点输入过大，请减少汇总来源或缩短节点输出。");
  return input;
}
