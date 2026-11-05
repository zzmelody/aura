import { join } from "node:path";
import type { Context, Fiber } from "@deepseek-ai/cordis";
import {
  SessionQueryError,
  type SessionQueryEngine,
} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-experimental-agent-team";
import type {} from "@deepseek-ai/dsh-experimental-speech-to-text";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type {
  AgentTeamView,
  IntegrationFlags,
  IntegrationSettings,
  McpServerInput,
} from "@aura/protocol/types";
import { FlowError } from "@aura/protocol/errors";
import type { Table } from "../types.ts";
import type { CodingConversationIndex } from "./index-record.ts";
import { searchCodingSessions } from "./session-search.ts";

const flags = z.strictObject({
  mcp: z.boolean(),
  market: z.boolean(),
  voice: z.boolean(),
  agentTeam: z.boolean(),
  sessionSearch: z.boolean(),
});
const name = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
const environmentName = z.string().regex(/^AURA_MCP_[A-Z0-9_]{1,64}$/u);
const server = z.discriminatedUnion("transport", [
  z.strictObject({
    name,
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(1024)).max(32),
    env: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u),
        environmentName,
      )
      .refine((value) => Object.keys(value).length <= 16),
  }),
  z.strictObject({
    name,
    transport: z.literal("streamable-http"),
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        const url = URL.parse(value);
        return (
          !!url &&
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      }),
    bearerEnv: environmentName.optional(),
  }),
]);
const record = z.strictObject({
  revision: z.number().int().nonnegative(),
  flags,
  servers: z.array(server).max(16),
});
const update = record
  .pick({ revision: true })
  .extend({
    flags: flags.optional(),
    server: server.optional(),
    removeServer: name.optional(),
  })
  .refine(
    (value) =>
      !!(value.flags || value.server || value.removeServer) &&
      !(value.server && value.removeServer),
  );
type IntegrationRecord = z.infer<typeof record>;
const defaults: IntegrationRecord = {
  revision: 0,
  flags: {
    mcp: false,
    market: false,
    voice: false,
    agentTeam: false,
    sessionSearch: false,
  },
  servers: [],
};
export const integrationsDomain = defineDomain({
  name: "aura_integrations",
  version: 1,
  layout: "per-record",
  tables: { settings: domainTable(record) },
});
const voiceProvider = "sensevoice-local";
export const MAX_VOICE_BYTES = 960_044;

export const teamToolNames = new Set([
  "spawn_teammate",
  "send_message",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
  "team_task_create",
  "team_task_list",
  "team_task_get",
  "team_task_update",
]);
const sharedAgentTools = new Set([
  "send_message",
  "list_agents",
  "interrupt_agent",
]);

interface McpConnection {
  spec: McpServerInput;
  status: "connecting" | "connected" | "unavailable";
  fiber?: Fiber;
}

export class CodingIntegrations {
  private readonly connections = new Map<string, McpConnection>();
  private readonly recordings = new Map<string, AbortController>();
  private writes: Promise<unknown> = Promise.resolve();
  private voice?: Fiber;
  private team?: Fiber;
  private searchIndex?: { fiber: Fiber; query: SessionQueryEngine };
  private readonly ctx: Context;
  private readonly table: Table<IntegrationRecord>;
  private readonly index: CodingConversationIndex;
  private readonly dataRoot: string;
  private readonly local: boolean;

  constructor(
    ctx: Context,
    table: Table<IntegrationRecord>,
    index: CodingConversationIndex,
    dataRoot: string,
    local: boolean,
  ) {
    this.ctx = ctx;
    this.table = table;
    this.index = index;
    this.dataRoot = dataRoot;
    this.local = local;
  }

  private current() {
    return this.table.get("settings") ?? defaults;
  }

  enabled(key: keyof IntegrationFlags) {
    return (key !== "mcp" || this.local) && this.current().flags[key];
  }

  flags(): IntegrationFlags {
    return { ...this.current().flags, mcp: this.enabled("mcp") };
  }

  mcpTools() {
    if (!this.enabled("mcp")) return [];
    const names = this.current().servers.flatMap((spec) => {
      const connection = this.connections.get(spec.name);
      return connection?.status === "connected" &&
        JSON.stringify(connection.spec) === JSON.stringify(spec)
        ? [`mcp__${spec.name}__`]
        : [];
    });
    const secrets = this.mcpSecrets();
    return this.ctx.tools
      .schemas()
      .filter(
        (schema) =>
          names.some((prefix) => schema.name.startsWith(prefix)) &&
          secrets.every(
            (value) =>
              !JSON.stringify(schema).includes(
                JSON.stringify(value).slice(1, -1),
              ),
          ),
      )
      .map(({ name: tool }) => tool);
  }

  private voiceState() {
    return this.ctx
      .get("speechToText")
      ?.snapshot()
      .providers.find(({ id }) => id === voiceProvider);
  }

  snapshot(): IntegrationSettings {
    const current = this.current();
    const tools = this.mcpTools();
    return {
      revision: current.revision,
      flags: this.flags(),
      mcpServers: current.servers.map(({ name: serverName, transport }) => ({
        name: serverName,
        transport,
        tools: tools.filter((tool) => tool.startsWith(`mcp__${serverName}__`)),
        status: this.enabled("mcp")
          ? (this.connections.get(serverName)?.status ?? "connecting")
          : "disabled",
      })),
      voicePhase: this.enabled("voice")
        ? (this.voiceState()?.preparation.phase ?? "unavailable")
        : "disabled",
    };
  }

  update(source: unknown) {
    const parsed = update.safeParse(source);
    if (!parsed.success)
      throw new FlowError("功能设置或 MCP 服务器配置无效。", 400);
    const input = parsed.data;
    return this.serialize(async () => {
      const current = this.current();
      if (input.revision !== current.revision)
        throw new FlowError("功能设置已变化，请刷新后保存。", 409);
      const replacement = input.server;
      const servers = current.servers.filter(
        ({ name: serverName }) =>
          serverName !== input.removeServer && serverName !== replacement?.name,
      );
      if (replacement) servers.push(replacement);
      if (servers.length > 16)
        throw new FlowError("最多可配置 16 个 MCP 服务器。", 400);
      await this.table.put("settings", {
        revision: current.revision + 1,
        flags: input.flags ?? current.flags,
        servers,
      });
      await this.reconcile();
      return this.snapshot();
    });
  }

  private serialize<T>(work: () => Promise<T>) {
    const result = this.writes.then(work);
    this.writes = result.catch(() => undefined);
    return result;
  }

  start() {
    void this.serialize(() => this.reconcile()).catch(() => undefined);
  }

  ready() {
    return this.writes;
  }

  private async reconcile() {
    const wanted = new Map(
      this.enabled("mcp")
        ? this.current().servers.map((spec) => [spec.name, spec] as const)
        : [],
    );
    for (const [serverName, connection] of this.connections) {
      if (
        connection.status !== "unavailable" &&
        JSON.stringify(wanted.get(serverName)) ===
          JSON.stringify(connection.spec)
      ) {
        wanted.delete(serverName);
        continue;
      }
      this.connections.delete(serverName);
      await connection.fiber?.dispose();
    }
    for (const spec of wanted.values()) {
      const connection: McpConnection = { spec, status: "connecting" };
      this.connections.set(spec.name, connection);
      void this.connect(connection);
    }
    const results = await Promise.allSettled([
      this.reconcileVoice(),
      this.reconcileTeam(),
      this.reconcileSearch(),
    ]);
    if (results.some(({ status }) => status === "rejected"))
      throw new FlowError(
        "开关已保存，部分 DSH 服务未能应用。请刷新后重试。",
        503,
      );
  }

  private async connect(connection: McpConnection) {
    const spec = connection.spec;
    try {
      const plugin = await import("@deepseek-ai/dsh-mcp-client");
      if (this.connections.get(spec.name) !== connection) return;
      const secret = (key: string) => {
        const value = process.env[key];
        if (!value) throw new Error("Missing MCP environment variable");
        return value;
      };
      const transport =
        spec.transport === "stdio"
          ? {
              transport: spec.transport,
              command: spec.command,
              args: spec.args,
              env: Object.fromEntries(
                Object.entries(spec.env).map(([variable, key]) => [
                  variable,
                  secret(key),
                ]),
              ),
            }
          : {
              transport: spec.transport,
              url: spec.url,
              ...(spec.bearerEnv
                ? {
                    headers: {
                      Authorization: `Bearer ${secret(spec.bearerEnv)}`,
                    },
                  }
                : {}),
            };
      // Only tools enter Aura's allow-list. Server instructions and resources
      // must stay out of the global prompt and other sessions.
      const scope = this.ctx
        .isolate("systemPrompt")
        .isolate("mcpResources")
        .intercept("logger", { level: -1 });
      const fiber = scope.plugin(plugin, {
        ...transport,
        serverName: spec.name,
        failOnStartupError: true,
      });
      connection.fiber = fiber;
      await fiber.await();
      connection.status = "connected";
    } catch {
      connection.status = "unavailable";
    }
  }

  mcpSecrets(): string[] {
    const keys = this.current().servers.flatMap((spec) =>
      spec.transport === "stdio"
        ? Object.values(spec.env)
        : spec.bearerEnv
          ? [spec.bearerEnv]
          : [],
    );
    return [
      ...new Set(
        keys
          .map((key) => process.env[key])
          .filter((value): value is string => !!value),
      ),
    ];
  }

  private async reconcileVoice() {
    if (!this.enabled("voice")) {
      for (const abort of this.recordings.values()) abort.abort();
      const provider = this.voiceState();
      if (provider)
        await this.ctx.get("speechToText")?.cancelPreparation(provider.id);
      await this.voice?.dispose();
      this.voice = undefined;
    } else if (!this.voice) {
      const [{ default: Speech }, senseVoice] = await Promise.all([
        import("@deepseek-ai/dsh-experimental-speech-to-text"),
        import("@deepseek-ai/dsh-experimental-speech-to-text-sensevoice"),
      ]);
      const mount = async (ctx: Context) => {
        await ctx
          .plugin(Speech, { defaultProvider: voiceProvider, language: "auto" })
          .await();
        await ctx
          .plugin(senseVoice, {
            dataRoot: join(this.dataRoot, "voice"),
            providerId: voiceProvider,
          })
          .await();
      };
      const fiber = this.ctx.plugin(mount);
      try {
        await fiber.await();
        this.voice = fiber;
      } catch (error) {
        await fiber.dispose();
        throw error;
      }
    }
  }

  prepareVoice(cancel: boolean) {
    const provider = this.enabled("voice") && this.voiceState();
    const service = this.ctx.get("speechToText");
    if (!provider || !service)
      throw new FlowError("SenseVoice 语音输入未启用或不可用。", 409);
    if (cancel) return service.cancelPreparation(provider.id);
    service.prepare(provider.id);
  }

  async transcribe(id: string, encoded: string) {
    const provider = this.enabled("voice") && this.voiceState();
    if (
      !provider ||
      !["ready", "standby", "waking"].includes(provider.preparation.phase)
    )
      throw new FlowError("请先准备 SenseVoice 模型。", 409);
    if (this.recordings.has(id)) throw new FlowError("录音正在识别。", 409);
    const abort = new AbortController();
    this.recordings.set(id, abort);
    try {
      const audio = Buffer.from(encoded, "base64");
      if (audio.length > MAX_VOICE_BYTES) throw new Error("Audio too large");
      const { validateWave } =
        await import("@deepseek-ai/dsh-experimental-speech-to-text/wave");
      validateWave(audio, 30);
      const service = this.ctx.get("speechToText");
      if (!service)
        throw new Error("Speech recognition service is unavailable");
      const spec = service.resolve({ audio, providerId: provider.id });
      const { text } = await service.transcribe(
        spec,
        AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      );
      return { text };
    } catch {
      throw new FlowError("语音识别未完成，请检查录音或模型状态。", 422);
    } finally {
      this.recordings.delete(id);
    }
  }

  cancelRecording(id: string) {
    this.recordings.get(id)?.abort();
  }

  private async reconcileTeam() {
    if (!this.enabled("agentTeam")) {
      await this.team?.dispose();
      this.team = undefined;
    } else if (!this.team) {
      const plugin =
        await import("@deepseek-ai/dsh-experimental-tool-agent-team");
      const fiber = this.ctx.plugin(plugin, {});
      try {
        await fiber.await();
        this.team = fiber;
      } catch (error) {
        await fiber.dispose();
        throw error;
      }
    }
  }

  teamTool(tool: string, agentId: string | undefined) {
    if (!teamToolNames.has(tool)) return false;
    if (!sharedAgentTools.has(tool)) return true;
    const agent = agentId && this.ctx.agents.get(SessionId(agentId));
    return !!agent && !!this.team && !!this.ctx.agentTeams.tryMembership(agent);
  }

  async teamView(id: string): Promise<AgentTeamView> {
    await this.ready();
    if (!this.enabled("agentTeam"))
      throw new FlowError("Agent 团队未启用。", 409);
    const record = this.index.get(id);
    if (!record || record.closedAt !== undefined)
      return { members: [], tasks: [] };
    const projectTask = ({
      id: task,
      subject,
      status,
      ownerName,
    }: {
      id: string;
      subject: string;
      status: string;
      ownerName?: string;
    }) => ({ id: task, subject, status, owner: ownerName });
    const agent = this.ctx.agents.get(SessionId(id));
    const service = this.ctx.agentTeams;
    if (agent && service.tryMembership(agent))
      return {
        members: service
          .listMembers(agent)
          .map(({ name: member, status }) => ({ name: member, status })),
        tasks: service.listTasks(agent).map(projectTask),
      };
    try {
      using observed = await this.ctx.sessionQuery.observeSession(
        SessionId(id),
      );
      const team = observed.projections?.values.agentTeam;
      return {
        members: (team?.members ?? []).map(({ name: member, phase }) => ({
          name: member,
          status: phase === "active" ? "inactive" : phase,
        })),
        tasks: (team?.tasks ?? []).map(projectTask),
      };
    } catch (error) {
      if (
        error instanceof SessionQueryError &&
        error.code === "SESSION_QUERY_SESSION_NOT_FOUND"
      )
        return { members: [], tasks: [] };
      throw error;
    }
  }

  async search(projectId: string, query: string) {
    await this.ready();
    if (!this.enabled("sessionSearch") || !this.searchIndex)
      throw new FlowError("会话全文搜索未启用或暂不可用。", 409);
    const titles = new Map(
      this.index.list(projectId).map((item) => [item.id, item.title]),
    );
    const hits = await searchCodingSessions(
      this.searchIndex.query,
      titles,
      query,
      AbortSignal.timeout(20_000),
    );
    return redactMcpResult(hits, this.mcpSecrets());
  }

  private async reconcileSearch() {
    if (!this.enabled("sessionSearch")) {
      const index = this.searchIndex;
      this.searchIndex = undefined;
      await index?.fiber.dispose();
    } else if (!this.searchIndex) {
      const { default: SQLiteSearch } =
        await import("@deepseek-ai/dsh-session-query-sqlite");
      const scope = this.ctx.isolate("sessionQuery");
      const fiber = scope.plugin(SQLiteSearch, {
        path: ":memory:",
        openAt: "first-search",
      });
      try {
        await fiber.await();
        this.searchIndex = { fiber, query: fiber.ctx.sessionQuery };
      } catch (error) {
        await fiber.dispose();
        throw error;
      }
    }
  }
}

export function redactMcpResult<T>(result: T, secrets: readonly string[]): T {
  if (!secrets.length) return result;
  const redact = (text: string) =>
    secrets.reduce(
      (current, secret) => current.replaceAll(secret, "[已遮罩]"),
      text,
    );
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redact(key), visit(item)]),
      );
    return value;
  };
  return visit(result) as T;
}
