import { createHash } from "node:crypto";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { CODING_RUN_INTENTS } from "@aura/protocol";
import { CHAT_IMAGE_LIMIT } from "@aura/protocol/types";
import type {
  ConversationCommand,
  ConversationReceipt,
} from "@aura/protocol/conversation-channel";
import { CodedFlowError } from "@aura/protocol/errors";
import {
  codingPermissionSchema,
  conversationMessageSchema,
  conversationModelSchema,
} from "./index-record.ts";

const id = z.string().min(1).max(200);
const uuid = z.uuid();
const mode = z.enum(["demo", "codex", "lumina", "custom"]);
const images = z
  .array(z.string().regex(/^[a-f0-9]{64}$/u))
  .max(CHAT_IMAGE_LIMIT)
  .optional();
const prompt = z.string().max(80_000);
const modelConfig = z
  .object({ mode, selection: conversationModelSchema })
  .strict()
  .optional();
const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      commandId: uuid,
      type: z.literal("turn.start"),
      input: z
        .object({
          projectId: id.optional(),
          prompt,
          images,
          forkFrom: id.optional(),
          branchFrom: id.optional(),
          branchAt: z.number().int().nonnegative().optional(),
          history: z.array(conversationMessageSchema).max(200).optional(),
          context: z.string().max(40_000).optional(),
          mode,
          modelConfig: conversationModelSchema.optional(),
          permission: codingPermissionSchema.optional(),
          intent: z.enum(CODING_RUN_INTENTS).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      commandId: uuid,
      type: z.literal("turn.steer"),
      executionId: uuid,
      prompt,
      images,
      modelConfig,
    })
    .strict(),
  z
    .object({
      commandId: uuid,
      type: z.literal("turn.stop"),
      executionId: uuid,
    })
    .strict(),
  z
    .object({
      commandId: uuid,
      type: z.literal("question.answer"),
      executionId: uuid,
      questionId: id,
      answers: z
        .array(
          z
            .object({
              id,
              selected: z.array(z.string().max(4000)).max(20),
              custom: z.string().max(4000).optional(),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
]);

export function parseConversationCommand(value: unknown): ConversationCommand {
  const result = commandSchema.safeParse(value);
  if (!result.success)
    throw new CodedFlowError("无效的会话命令。", 400, {
      code: "conversation_command_invalid",
    });
  const command = result.data;
  const input =
    command.type === "turn.start"
      ? command.input
      : command.type === "turn.steer"
        ? command
        : undefined;
  if (input && !input.prompt.trim() && !input.images?.length)
    throw new CodedFlowError("消息内容不能为空。", 400, {
      code: "conversation_message_empty",
    });
  return command;
}

const executionSchema = z.object({
  id: uuid,
  commandId: uuid,
  prompt,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum([
    "preparing",
    "running",
    "stopping",
    "complete",
    "stopped",
    "error",
    "interrupted",
  ]),
  error: z.string().optional(),
  errorStatus: z.number().int().min(400).max(599).optional(),
  model: z.string().optional(),
});
const receiptSchema = z.object({
  commandId: uuid,
  sessionId: id,
  executionId: uuid,
  status: z.enum(["accepted", "applied", "rejected", "uncertain"]),
  error: z.string().optional(),
  execution: executionSchema.optional(),
});
export interface ConversationCommandRecord {
  digest: string;
  epoch: string;
  receipt: ConversationReceipt;
}

/** Additive receipts only; existing conversation domains and DSH logs are untouched. */
export const conversationCommandsDomain = defineDomain({
  name: "aura_conversation_commands",
  version: 1,
  layout: "per-record",
  tables: {
    commands: domainTable(
      z.object({ digest: z.string(), epoch: uuid, receipt: receiptSchema }),
    ),
  },
});

/** Canonical object ordering makes retries independent of JSON property order. */
export function commandDigest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function commandKey(sessionId: string, commandId: string): string {
  return commandDigest([sessionId, commandId]);
}
