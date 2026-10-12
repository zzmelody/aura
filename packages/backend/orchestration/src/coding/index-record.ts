import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { FlowError } from "../schema.ts";
import type { CodingConversation, Table } from "../types.ts";

/**
 * DSH's session header carries no title and no activity timestamp, so the
 * conversation list a client renders comes from Aura's own index. It stores
 * only presentation facts; the session log itself remains DSH's.
 */
export interface CodingConversationRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

const recordSchema = z.custom<CodingConversationRecord>((value) => {
  const record = value as CodingConversationRecord;
  return (
    typeof record?.id === "string" &&
    typeof record.projectId === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
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

  constructor(table: Table<CodingConversationRecord>) {
    this.table = table;
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
  ): Promise<CodingConversationRecord> {
    const existing = this.table.get(id);
    if (existing) {
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
    return this.table.get(id);
  }

  /** Conversations of one project, most recently active first. */
  list(projectId: string): CodingConversation[] {
    return [...this.table.entries()]
      .map(([, record]) => record)
      .filter((record) => record.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(conversation);
  }

  /** Drops the index entry; the DSH session log stays readable. */
  async remove(id: string): Promise<void> {
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
  };
}
