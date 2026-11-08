import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type { CodingCapabilities } from "@aura/protocol/types";
import type { Table } from "../types.ts";
import { CodedFlowError } from "@aura/protocol/errors";

export const WEB_CREDENTIAL = "AURA_DEEPSEEK_WEB_KEY";
const settings = z.object({
  revision: z.number().int().nonnegative(),
  autoCompact: z.boolean(),
  web: z.boolean(),
  subagents: z.boolean(),
});
const entry = z.object({
  kind: z.enum(["compaction", "subagent", "web", "goal", "mcp", "title"]),
  sessionId: z.string(),
  state: z.enum(["reserved", "complete", "unknown", "acknowledged"]),
  at: z.number(),
});
const record = settings.extend({
  // Retain the stored v1 field without enforcing or rewriting its old value.
  maxRequests: z.number().int().min(0).max(100_000),
  entries: z.record(z.string(), entry),
});
export type CapabilityRecord = z.infer<typeof record>;
export const capabilitiesDomain = defineDomain({
  name: "aura_coding_capabilities",
  version: 1,
  layout: "per-record",
  tables: { settings: domainTable(record) },
});
const defaults: CapabilityRecord = {
  revision: 0,
  autoCompact: false,
  web: false,
  subagents: false,
  maxRequests: 0,
  entries: {},
};

const budgetMessages = {
  extra_request_uncertain:
    "有结果未知的额外请求，请在对话能力设置中核对后继续。",
  extra_request_budget_exhausted:
    "额外请求额度不足，请在对话能力设置中增加额度。",
} as const;
type BudgetCode = keyof typeof budgetMessages;

function budgetError(code: BudgetCode): CodedFlowError {
  return new CodedFlowError(budgetMessages[code], 409, { code });
}

/**
 * DSH persists a child's turn error as plain text, dropping our error code.
 * Preserve display codes for historical refusals from the retired quota policy.
 */
export function budgetFailure(message?: string): CodedFlowError | undefined {
  const code = (Object.keys(budgetMessages) as BudgetCode[]).find((key) =>
    message?.includes(budgetMessages[key]),
  );
  return code ? budgetError(code) : undefined;
}

/** User-owned request ledger; unknown outcomes never block unrelated requests. */
export class CodingCapabilityStore {
  private readonly table: Table<CapabilityRecord>;
  private readonly credentials: Context["credentials"];
  private writes: Promise<unknown> = Promise.resolve();
  private readonly live = new Set<string>();

  constructor(
    table: Table<CapabilityRecord>,
    credentials: Context["credentials"],
  ) {
    this.table = table;
    this.credentials = credentials;
  }
  config() {
    return this.table.get("settings") ?? defaults;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.catch(() => undefined);
    return result;
  }
  async snapshot(): Promise<CodingCapabilities> {
    const config = this.config();
    const key = await this.credentials.describe(credentialRef(WEB_CREDENTIAL));
    return {
      revision: config.revision,
      autoCompact: config.autoCompact,
      web: config.web,
      subagents: config.subagents,
      usedRequests: Object.keys(config.entries).length,
      unknownRequests: Object.entries(config.entries).filter(
        ([id, item]) =>
          item.state === "unknown" ||
          (item.state === "reserved" && !this.live.has(id)),
      ).length,
      hasWebKey: key.configured,
    };
  }
  async save(source: unknown): Promise<CodingCapabilities> {
    const parsed = settings
      .extend({
        key: z.string().trim().min(1).max(4096).optional(),
        clearKey: z.boolean().optional(),
      })
      .strict()
      .safeParse(source);
    if (!parsed.success)
      throw new CodedFlowError("对话能力配置无效。", 400, {
        code: "capabilities_invalid",
      });
    const input = parsed.data;
    if (input.key && (input.clearKey || /\s/u.test(input.key)))
      throw new CodedFlowError("Web 密钥无效。", 400, {
        code: "web_key_invalid",
      });
    await this.serialize(async () => {
      const prior = this.config();
      if (input.revision !== prior.revision)
        throw new CodedFlowError("配置已变化，请刷新后保存。", 409, {
          code: "settings_revision_conflict",
        });
      const ref = credentialRef(WEB_CREDENTIAL);
      const previousKey =
        input.key || input.clearKey
          ? await this.credentials.resolve(ref)
          : undefined;
      if (input.key)
        await this.credentials.set(credentialRef(WEB_CREDENTIAL), input.key);
      if (input.clearKey)
        await this.credentials.unset(credentialRef(WEB_CREDENTIAL));
      try {
        await this.table.put("settings", {
          ...prior,
          ...settings.parse(input),
          revision: prior.revision + 1,
        });
      } catch (error) {
        if (previousKey) await this.credentials.set(ref, previousKey.value);
        else if (input.key) await this.credentials.unset(ref);
        throw error;
      }
    });
    return this.snapshot();
  }
  async reserve(
    kind: z.infer<typeof entry>["kind"],
    sessionId: string,
  ): Promise<string> {
    return this.serialize(async () => {
      const prior = this.config();
      if (
        kind === "title" &&
        Object.values(prior.entries).some(
          (item) => item.kind === "title" && item.sessionId === sessionId,
        )
      )
        throw new CodedFlowError("这段对话已请求过标题提炼。", 409, {
          code: "title_request_exists",
        });
      const id = randomUUID();
      await this.table.put("settings", {
        ...prior,
        entries: {
          ...prior.entries,
          [id]: { kind, sessionId, state: "reserved", at: Date.now() },
        },
      });
      this.live.add(id);
      return id;
    });
  }
  async settle(id: string, complete: boolean): Promise<void> {
    await this.serialize(async () => {
      const prior = this.config();
      const item = prior.entries[id];
      if (!item)
        throw new CodedFlowError("额外请求账本缺少预留记录。", 409, {
          code: "extra_request_reservation_missing",
        });
      await this.table.put("settings", {
        ...prior,
        entries: {
          ...prior.entries,
          [id]: { ...item, state: complete ? "complete" : "unknown" },
        },
      });
      this.live.delete(id);
    });
  }
}
