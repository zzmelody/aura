import { randomUUID } from "node:crypto";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import {
  conversationSides,
  PERSONAL_ASSISTANT_SESSION_ID,
} from "@aura/protocol/conversations";
import { FlowError } from "../schema.ts";
import type { CodingConversation, Table } from "../types.ts";
import type {
  ChatMessage,
  ChatModelSelection,
  FlowMode,
  CodingSideConversationInfo,
} from "@aura/protocol/types";

/**
 * DSH's session header carries no title and no activity timestamp, so the
 * conversation list a client renders comes from Aura's own index. It stores
 * durable conversation metadata, model choices and optional legacy import
 * context; the execution log itself remains DSH's.
 */
export interface CodingConversationRecord extends CodingConversation {
  /** A tombstone prevents delayed requests from reopening a closed parent. */
  closedAt?: number;
  history?: ChatMessage[];
  sourceEndSeq?: number;
}

export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(80_000),
  images: z
    .array(z.string().regex(/^[a-f0-9]{64}$/u))
    .max(4)
    .optional(),
});
export const conversationModelSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    reasoningEffort: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
const modelConfigSchema = z.partialRecord(
  z.enum(["demo", "codex", "lumina", "custom"]),
  conversationModelSchema,
);

const recordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().optional(),
  closedAt: z.number().optional(),
  sideSessionId: z.string().startsWith("side-").optional(),
  sideConversations: z
    .array(
      z.object({
        id: z.string().startsWith("side-"),
        title: z.string(),
        createdAt: z.number(),
        modelConfig: modelConfigSchema.optional(),
      }),
    )
    .optional(),
  sourceSessionId: z.string().optional(),
  sourceEndSeq: z.number().int().nonnegative().optional(),
  history: z.array(conversationMessageSchema).max(200).optional(),
  modelConfig: modelConfigSchema.optional(),
  sideModelConfig: modelConfigSchema.optional(),
});

export const codingDomainSpec = defineDomain({
  name: "aura_coding_conversations",
  version: 1,
  layout: "per-record",
  tables: { conversations: domainTable(recordSchema) },
});

/** Durable index of coding conversations, keyed by the coding session id. */
export class CodingConversationIndex {
  private readonly table: Table<CodingConversationRecord>;
  private assistantOpening?: Promise<CodingConversation>;

  constructor(table: Table<CodingConversationRecord>) {
    this.table = table;
  }

  getAssistant(): CodingConversation | undefined {
    const record = this.get(PERSONAL_ASSISTANT_SESSION_ID);
    return record ? conversation(record) : undefined;
  }

  /** Only an explicit open creates the singleton; repeated opens never fork it. */
  openAssistant(projectId: string): Promise<CodingConversation> {
    const existing = this.getAssistant();
    if (existing) return Promise.resolve(existing);
    if (!this.assistantOpening)
      this.assistantOpening = this.open(
        PERSONAL_ASSISTANT_SESSION_ID,
        projectId,
        "Aura",
      )
        .then(conversation)
        .finally(() => {
          this.assistantOpening = undefined;
        });
    return this.assistantOpening;
  }

  /**
   * Records a conversation on its first turn; later turns only bump activity,
   * so the first request stays the title. A session is bound to one project
   * directory for life, so reusing its id under another project is refused.
   */
  async open(
    id: string,
    projectId: string,
    prompt: string,
    seed: {
      history?: ChatMessage[];
      sourceSessionId?: string;
      sourceEndSeq?: number;
    } = {},
  ): Promise<CodingConversationRecord> {
    if (id.startsWith("side-"))
      throw new FlowError("旁支对话不能作为主对话打开。", 400);
    const existing = this.table.get(id);
    if (existing) {
      if (existing.closedAt !== undefined || existing.archivedAt !== undefined)
        throw new FlowError("这段对话已关闭或归档。", 409);
      if (existing.projectId !== projectId)
        throw new FlowError("这段对话属于另一个项目，请新建对话。", 409);
      return this.touch(id);
    }
    const now = Date.now();
    const record: CodingConversationRecord = {
      id,
      projectId,
      title: prompt.replace(/\s+/gu, " ").trim().slice(0, 80) || "新的对话",
      createdAt: now,
      updatedAt: now,
      ...seed,
    };
    await this.table.put(id, record);
    return record;
  }

  /** Bumps activity so the sidebar can order conversations by recency. */
  async touch(
    id: string,
    patch: { title?: string } = {},
  ): Promise<CodingConversationRecord> {
    return this.table.update(id, (current) => ({
      ...current,
      ...(patch.title ? { title: patch.title.slice(0, 80) } : {}),
      updatedAt: Date.now(),
    }));
  }

  get(id: string): CodingConversationRecord | undefined {
    const record = this.table.get(id);
    return record?.closedAt === undefined ? record : undefined;
  }

  modelConfig(id: string) {
    return id.startsWith("side-")
      ? this.side(this.sideParent(id), id)?.modelConfig
      : this.get(id)?.modelConfig;
  }

  async selectModel(id: string, mode: FlowMode, selection: ChatModelSelection) {
    const side = id.startsWith("side-");
    const parent = side ? this.sideParent(id) : this.get(id);
    if (!parent || parent.archivedAt !== undefined)
      throw new FlowError("对话不存在或已归档。", 404);
    await this.table.update(parent.id, (current) => {
      if (current.closedAt !== undefined || current.archivedAt !== undefined)
        throw new FlowError("对话不存在或已归档。", 404);
      if (!side)
        return {
          ...current,
          modelConfig: { ...current.modelConfig, [mode]: selection },
        };
      const sides = conversationSides(current);
      if (!sides.some((item) => item.id === id))
        throw new FlowError("旁支已关闭。", 404);
      return withSides(
        current,
        sides.map((item) =>
          item.id === id
            ? {
                ...item,
                modelConfig: { ...item.modelConfig, [mode]: selection },
              }
            : item,
        ),
      );
    });
  }

  private side(parent: CodingConversationRecord | undefined, id: string) {
    return parent
      ? conversationSides(parent).find((item) => item.id === id)
      : undefined;
  }

  /** Every explicit creation allocates an independent, durable side chat. */
  async openSide(parentId: string): Promise<string> {
    if (!this.get(parentId)) throw new FlowError("主对话不存在或已关闭。", 404);
    const id = `side-${randomUUID()}`;
    await this.table.update(parentId, (current) => {
      if (current.closedAt !== undefined || current.archivedAt !== undefined)
        throw new FlowError("主对话已关闭或归档。", 409);
      return withSides(current, [
        ...conversationSides(current),
        {
          id,
          title: "新侧边对话",
          createdAt: Date.now(),
        },
      ]);
    });
    return id;
  }

  /** The first submitted question names the branch in the sidebar. */
  async nameSide(sessionId: string, prompt: string): Promise<void> {
    const parent = this.sideParent(sessionId);
    if (!parent) throw new FlowError("旁支已关闭。", 404);
    await this.table.update(parent.id, (current) => {
      if (
        current.closedAt !== undefined ||
        current.archivedAt !== undefined ||
        !this.side(current, sessionId)
      )
        throw new FlowError("旁支已关闭。", 404);
      return withSides(
        current,
        conversationSides(current).map((item) =>
          item.id === sessionId &&
          ["新旁支对话", "新侧边对话"].includes(item.title)
            ? {
                ...item,
                title:
                  prompt.replace(/\s+/gu, " ").trim().slice(0, 80) ||
                  "图片对话",
              }
            : item,
        ),
      );
    });
  }

  /** Only a still-open parent grants access to a side chat's stored log. */
  sideParent(sessionId: string): CodingConversationRecord | undefined {
    return [...this.table.entries()]
      .map(([, record]) => record)
      .find(
        (record) =>
          record.closedAt === undefined &&
          record.archivedAt === undefined &&
          this.side(record, sessionId) !== undefined,
      );
  }

  async closeSide(sessionId: string): Promise<boolean> {
    const parent = this.sideParent(sessionId);
    if (!parent) return false;
    await this.table.update(parent.id, (current) => {
      return withSides(
        current,
        conversationSides(current).filter((item) => item.id !== sessionId),
      );
    });
    return true;
  }

  /** Archiving or closing a parent forgets its side, never its DSH logs. */
  async archive(id: string, archived: boolean): Promise<void> {
    if (archived && id === PERSONAL_ASSISTANT_SESSION_ID)
      throw new FlowError("Aura 个人助手是固定会话，不能归档。", 409);
    if (!this.get(id)) throw new FlowError("对话不存在或已关闭。", 404);
    await this.table.update(id, (current) => {
      const {
        archivedAt: _archived,
        sideSessionId: _side,
        sideModelConfig: _sideModelConfig,
        sideConversations: _sideConversations,
        ...rest
      } = current;
      return archived ? { ...rest, archivedAt: Date.now() } : rest;
    });
  }

  async close(id: string): Promise<void> {
    if (id === PERSONAL_ASSISTANT_SESSION_ID)
      throw new FlowError("Aura 个人助手是固定会话，不能关闭。", 409);
    if (!this.get(id)) return;
    await this.table.update(id, (current) => {
      const {
        sideSessionId: _side,
        sideModelConfig: _sideModelConfig,
        sideConversations: _sideConversations,
        ...rest
      } = current;
      return { ...rest, closedAt: Date.now() };
    });
  }

  /** Conversations of one project, most recently active first. */
  list(projectId: string): CodingConversation[] {
    return [...this.table.entries()]
      .map(([, record]) => record)
      .filter(
        (record) =>
          record.projectId === projectId && record.closedAt === undefined,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(conversation);
  }

  /** Drops the index entry; the DSH session log stays readable. */
  async remove(id: string): Promise<void> {
    if (id === PERSONAL_ASSISTANT_SESSION_ID)
      throw new FlowError("Aura 个人助手是固定会话，不能删除。", 409);
    await this.table.delete(id);
  }
}

function conversation(record: CodingConversationRecord): CodingConversation {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.archivedAt !== undefined
      ? { archivedAt: record.archivedAt }
      : {}),
    ...(record.sideSessionId ? { sideSessionId: record.sideSessionId } : {}),
    ...(conversationSides(record).length
      ? { sideConversations: conversationSides(record) }
      : {}),
    ...(record.modelConfig ? { modelConfig: record.modelConfig } : {}),
    ...(record.sideModelConfig
      ? { sideModelConfig: record.sideModelConfig }
      : {}),
    ...(record.sourceSessionId
      ? { sourceSessionId: record.sourceSessionId }
      : {}),
  };
}

/** Keep legacy fields in sync on user actions; reads never rewrite records. */
function withSides(
  record: CodingConversationRecord,
  sides: CodingSideConversationInfo[],
): CodingConversationRecord {
  const {
    sideSessionId: _side,
    sideModelConfig: _model,
    sideConversations: _sides,
    ...rest
  } = record;
  const first = sides[0];
  return first
    ? {
        ...rest,
        sideSessionId: first.id,
        sideConversations: sides,
        ...(first.modelConfig ? { sideModelConfig: first.modelConfig } : {}),
      }
    : rest;
}
