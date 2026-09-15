import type { JsonValue } from "@aura/protocol/types";
import { z } from "zod";
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values";

export const flowIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(180_000);
export const retrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(1),
    initialDelayMs: z.number().int().min(0).max(600_000).default(1000),
    multiplier: z.number().min(1).max(10).default(2),
    maxDelayMs: z.number().int().min(0).max(600_000).default(30_000),
  })
  .strict();

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
    actions: z.array(flowIdSchema).max(64).default([]),
    retry: retrySchema.optional(),
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
export const runPhaseSchema = z.enum([
  ...phaseSchema.options,
  "pausing",
  "paused",
  "waiting_input",
  "needs_attention",
]);
export const stepPhaseSchema = z.enum([
  ...phaseSchema.options,
  "waiting_input",
  "unknown",
]);
export const recoveryEventSchema = z.object({
  at: z.number(),
  reason: z.string(),
  action: z.enum(["retry", "submit_output", "terminate"]).optional(),
  requestId: z.uuid().optional(),
});
export const attemptSchema = z.object({
  number: z.number().int().positive(),
  status: z.enum([
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "unknown",
  ]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  sessionId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  error: z.string().optional(),
});

const stepBase = {
  id: flowIdSchema,
  label: z.string(),
  status: stepPhaseSchema,
  stepKey: z.string().optional(),
  scopePath: z.array(flowIdSchema).optional(),
  requestHash: z.string().length(64).optional(),
  attempts: z.array(attemptSchema).optional(),
  retry: retrySchema.optional(),
  extraAttempts: z.number().int().nonnegative().optional(),
  nextAttemptAt: z.number().optional(),
  recoveryEvents: z.array(recoveryEventSchema).optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
};

const actionRefSchema = z.object({
  id: flowIdSchema,
  sourceHash: z.string().length(64),
});
export const stepSchema = z.union([
  z.object({
    ...stepBase,
    kind: z.literal("agent").default("agent"),
    preset: flowIdSchema,
    sessionId: z.uuid(),
    requestId: z.uuid().optional(),
    actions: z.array(actionRefSchema).optional(),
    output: z.string().optional(),
  }),
  z.object({
    ...stepBase,
    kind: z.literal("action"),
    actionId: flowIdSchema,
    sourceHash: z.string().length(64).optional(),
    input: z.json(),
    output: z.json().optional(),
    outputSchema: z.json().optional(),
    recovery: z.enum(["manual", "idempotent"]).optional(),
    idempotencyKey: z.uuid().optional(),
  }),
  z.object({
    ...stepBase,
    kind: z.literal("memo"),
    outputSchema: z.json(),
    output: z.json().optional(),
  }),
  z.object({
    ...stepBase,
    kind: z.literal("checkpoint"),
    prompt: z.string(),
    outputSchema: z.json(),
    output: z.json().optional(),
  }),
]);

export const actionRequestSchema = z
  .object({
    id: flowIdSchema,
    label: z.string().trim().min(1).max(100).optional(),
    action: flowIdSchema,
    input: z.unknown(),
    retry: retrySchema.optional(),
  })
  .strict();

export const actionStartSchema = z
  .object({
    requestId: z.uuid(),
    actionId: flowIdSchema,
    input: z.unknown(),
    mode: z.enum(["demo", "codex"]),
  })
  .strict();

export const actionRunSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  actionId: flowIdSchema,
  sourceHash: z.string().length(64),
  input: z.json(),
  output: z.json().optional(),
  mode: z.enum(["demo", "codex"]),
  status: phaseSchema,
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
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
  status: runPhaseSchema,
  durableVersion: z.literal(1).optional(),
  requestInputHash: z.string().length(64).optional(),
  actionVersions: z.array(actionRefSchema).optional(),
  queuedAt: z.number().optional(),
  updatedAt: z.number().optional(),
  recoveryEvents: z.array(recoveryEventSchema).optional(),
  commands: z
    .array(
      z.object({
        requestId: z.uuid(),
        fingerprint: z.string(),
        status: runPhaseSchema,
        at: z.number(),
      }),
    )
    .optional(),
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
  return jsonValue(parsed, label, maxBytes);
}

export function jsonValue(
  value: unknown,
  label: string,
  maxBytes = 256 * 1_024,
): JsonValue {
  const json = snapshotJsonValue(value);
  if (json === undefined)
    throw new FlowError(`${label}必须是可序列化的 JSON 数据。`);
  const content = JSON.stringify(json);
  if (Buffer.byteLength(content, "utf8") > maxBytes)
    throw new FlowError(`${label}超过 ${maxBytes} 字节限制。`, 413);
  return json as JsonValue;
}
