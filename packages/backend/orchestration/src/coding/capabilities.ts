import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type { CodingCapabilities } from "@aura/protocol/types";
import type { Table } from "../types.ts";
import { FlowError } from "../schema.ts";

export const WEB_CREDENTIAL = "AURA_DEEPSEEK_WEB_KEY";
const settings = z.object({
  revision: z.number().int().nonnegative(),
  autoCompact: z.boolean(),
  web: z.boolean(),
  subagents: z.boolean(),
  maxRequests: z.number().int().min(0).max(100_000),
});
const entry = z.object({
  kind: z.enum(["compaction", "subagent", "web", "goal", "mcp"]),
  sessionId: z.string(),
  state: z.enum(["reserved", "complete", "unknown", "acknowledged"]),
  at: z.number(),
});
const record = settings.extend({ entries: z.record(z.string(), entry) });
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

/** User-owned request allowance; a reservation is never refunded on uncertainty. */
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
      maxRequests: config.maxRequests,
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
        acknowledgeUnknown: z.boolean().optional(),
      })
      .strict()
      .safeParse(source);
    if (!parsed.success) throw new FlowError("对话能力配置无效。", 400);
    const input = parsed.data;
    if (input.key && (input.clearKey || /\s/u.test(input.key)))
      throw new FlowError("Web 密钥无效。", 400);
    await this.serialize(async () => {
      const prior = this.config();
      if (input.revision !== prior.revision)
        throw new FlowError("配置已变化，请刷新后保存。", 409);
      const ref = credentialRef(WEB_CREDENTIAL);
      const previousKey =
        input.key || input.clearKey
          ? await this.credentials.resolve(ref)
          : undefined;
      if (input.key)
        await this.credentials.set(credentialRef(WEB_CREDENTIAL), input.key);
      if (input.clearKey)
        await this.credentials.unset(credentialRef(WEB_CREDENTIAL));
      const entries = structuredClone(prior.entries);
      if (input.acknowledgeUnknown)
        for (const [id, item] of Object.entries(entries))
          if (
            item.state === "unknown" ||
            (item.state === "reserved" && !this.live.has(id))
          )
            item.state = "acknowledged";
      try {
        await this.table.put("settings", {
          ...settings.parse(input),
          revision: prior.revision + 1,
          entries,
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
      this.assertBudgetAvailable(prior);
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
  assertBudgetAvailable(prior = this.config()): void {
    if (
      Object.entries(prior.entries).some(
        ([id, item]) =>
          item.state === "unknown" ||
          (item.state === "reserved" && !this.live.has(id)),
      )
    )
      throw new FlowError(
        "有结果未知的额外请求，请在对话能力设置中核对后继续。",
        409,
      );
    if (Object.keys(prior.entries).length >= prior.maxRequests)
      throw new FlowError(
        "额外请求额度不足，请在对话能力设置中增加额度。",
        409,
      );
  }
  async settle(id: string, complete: boolean): Promise<void> {
    await this.serialize(async () => {
      const prior = this.config();
      const item = prior.entries[id];
      if (!item) throw new FlowError("额外请求账本缺少预留记录。", 409);
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
