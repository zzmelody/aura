import type { JsonValue } from "@aura/protocol/types";
import { z } from "zod";

export const flowIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(180_000);

export const startSchema = z
  .object({
    requestId: z.uuid(),
    flowId: flowIdSchema,
    input: z.unknown(),
    mode: z.enum(["demo", "codex"]),
  })
  .strict();

export const agentRequestSchema = z
  .object({
    id: flowIdSchema,
    label: z.string().trim().min(1).max(100),
    preset: flowIdSchema,
    prompt: text,
  })
  .strict();

export const phaseSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const stepSchema = z.object({
  id: flowIdSchema,
  label: z.string(),
  preset: flowIdSchema,
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
  flow: z.object({
    id: flowIdSchema,
    title: z.string(),
    description: z.string(),
    sourceHash: z.string().length(64),
  }),
  input: z.json(),
  mode: z.enum(["demo", "codex"]),
  status: phaseSchema,
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  steps: z.array(stepSchema),
  output: z.json().optional(),
  error: z.string().optional(),
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

export function parseJson(
  schema: z.ZodType,
  value: unknown,
  label: string,
  maxBytes = 256 * 1_024,
): JsonValue {
  let parsed: unknown;
  try {
    parsed = parse(schema, value);
  } catch (error) {
    if (error instanceof FlowError)
      throw new FlowError(`${label}：${error.message}`, error.status);
    throw error;
  }
  const json = z.json().safeParse(parsed);
  if (!json.success)
    throw new FlowError(`${label}必须是可序列化的 JSON 数据。`);
  const content = JSON.stringify(json.data);
  if (Buffer.byteLength(content, "utf8") > maxBytes)
    throw new FlowError(`${label}超过 ${maxBytes} 字节限制。`, 413);
  return JSON.parse(content) as JsonValue;
}
