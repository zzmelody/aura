import {
  agentConfigSchema,
  agentOptionsSchema,
} from "@aura/dsh-auth/model-config";
import { FlowError } from "@aura/protocol/errors";
import type { JsonValue } from "@aura/protocol/types";
import { z } from "zod";
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values";

export const flowIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const contributionIdSchema = z
  .string()
  .regex(
    /^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}|[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)$/u,
  );
const pluginIdentitySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u),
    name: z.string().min(1).max(80),
    version: z.string().min(1).max(100),
  })
  .strict();
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
    flowId: contributionIdSchema,
    input: z.unknown(),
    mode: z.enum(["demo", "codex", "lumina", "custom"]),
    /** Internal HTTP-boundary guard; callers cannot publish an unlisted Flow. */
    serviceOnly: z.boolean().optional(),
    useConfiguredModel: z.boolean().optional(),
  })
  .strict();

export {
  agentConfigSchema,
  agentOptionsSchema,
} from "@aura/dsh-auth/model-config";

export const flowImageSchema = z
  .object({
    attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    bytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    name: z.string().max(200).optional(),
    originalDimensions: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const agentRequestSchema = agentOptionsSchema
  .extend({
    id: flowIdSchema,
    label: z.string().trim().min(1).max(100),
    preset: contributionIdSchema,
    prompt: text,
    images: z.array(flowImageSchema).max(4).optional(),
    actions: z.array(contributionIdSchema).max(64).default([]),
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
  id: contributionIdSchema,
  sourceHash: z.string().length(64).optional(),
  plugin: pluginIdentitySchema.optional(),
});
export const stepSchema = z.union([
  z.object({
    ...stepBase,
    kind: z.literal("agent").default("agent"),
    preset: contributionIdSchema,
    sessionId: z.uuid(),
    requestId: z.uuid().optional(),
    actions: z.array(actionRefSchema).optional(),
    config: agentConfigSchema.optional(),
    output: z.string().optional(),
  }),
  z.object({
    ...stepBase,
    kind: z.literal("action"),
    actionId: contributionIdSchema,
    sourceHash: z.string().length(64).optional(),
    plugin: pluginIdentitySchema.optional(),
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
  z.object({
    ...stepBase,
    kind: z.literal("flow"),
    flowId: contributionIdSchema,
    sourceHash: z.string().length(64).optional(),
    plugin: pluginIdentitySchema.optional(),
    input: z.json(),
    outputSchema: z.json(),
    childRequestId: z.uuid(),
    childRunId: z.uuid().optional(),
    requestInputHash: z.string().length(64),
    output: z.json().optional(),
  }),
]);

export const actionRequestSchema = z
  .object({
    id: flowIdSchema,
    label: z.string().trim().min(1).max(100).optional(),
    action: contributionIdSchema,
    input: z.unknown(),
    retry: retrySchema.optional(),
  })
  .strict();

export const flowRequestSchema = z
  .object({
    id: flowIdSchema,
    label: z.string().trim().min(1).max(100).optional(),
    flow: contributionIdSchema,
    input: z.unknown(),
  })
  .strict();

export const actionStartSchema = z
  .object({
    requestId: z.uuid(),
    actionId: contributionIdSchema,
    input: z.unknown(),
    mode: z.enum(["demo", "codex", "lumina", "custom"]),
  })
  .strict();

export const actionRunSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  actionId: contributionIdSchema,
  sourceHash: z.string().length(64).optional(),
  plugin: pluginIdentitySchema.optional(),
  input: z.json(),
  output: z.json().optional(),
  mode: z.enum(["demo", "codex", "lumina", "custom"]),
  status: phaseSchema,
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
});

export const runSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  conversationId: z.string().min(1).max(200).optional(),
  flow: z.object({
    id: contributionIdSchema,
    title: z.string(),
    description: z.string(),
    sourceHash: z.string().length(64).optional(),
    plugin: pluginIdentitySchema.optional(),
  }),
  input: z.json(),
  mode: z.enum(["demo", "codex", "lumina", "custom"]),
  status: runPhaseSchema,
  durableVersion: z.literal(1).optional(),
  agentDefaults: agentConfigSchema.optional(),
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
  parent: z
    .object({
      runId: z.uuid(),
      stepKey: z.string().min(1),
    })
    .optional(),
  rootRunId: z.uuid().optional(),
  report: z.json().optional(),
  settledAt: z.number().optional(),
  ancestry: z.array(contributionIdSchema).max(8).optional(),
});

export const active = (status: string) =>
  status === "queued" || status === "running";

export { FlowError };

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
