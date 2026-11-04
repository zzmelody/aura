import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  FlowCatalogEntry,
  FlowSource,
  JsonValue,
  FlowAgentOptions,
  AuraPluginIdentity,
} from "@aura/protocol/types";
import { z } from "zod";
import type { FlowDefinition, FlowRegistrationConfig } from "./flow-api.ts";
import {
  contributionIdSchema,
  FlowError,
  parse,
  agentOptionsSchema,
} from "./schema.ts";
import { validateFlowSource } from "./flow-diagnostics.ts";
import { CALL_TIMEOUT_MS } from "./timeouts.ts";

export interface LoadedFlow {
  id: string;
  title: string;
  description: string;
  service: boolean;
  /** Legacy metadata only; current definitions have no content hash. */
  sourceHash?: string;
  revision?: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  concurrency: number;
  stepLimit?: number;
  agentTimeoutMs: number;
  agentDefaults?: FlowAgentOptions;
  plugin?: AuraPluginIdentity;
  permissions: readonly string[];
  legacyIdentity?: boolean;
  ownerPlugin?: AuraPluginIdentity;
  run: FlowDefinition["run"];
}

const definitionSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).default(""),
    service: z.boolean().default(false),
    input: z.custom<z.ZodType>((value) => value instanceof z.ZodType, {
      error: "input 必须是 Zod schema",
    }),
    output: z.custom<z.ZodType>((value) => value instanceof z.ZodType, {
      error: "output 必须是 Zod schema",
    }),
    concurrency: z.number().int().min(1).max(4).default(2),
    stepLimit: z.number().int().min(1).max(4096).default(64),
    agentTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(CALL_TIMEOUT_MS)
      .default(CALL_TIMEOUT_MS),
    agentDefaults: agentOptionsSchema.optional(),
    run: z.custom<FlowDefinition["run"]>(
      (value) => typeof value === "function",
      { error: "run 必须是函数" },
    ),
  })
  .strict();

/** Last-known-good Flow registry populated by Loader-managed Flow plugins. */
export class FlowRegistry {
  private loaded = new Map<string, LoadedFlow>();
  private sources = new Map<string, FlowSource>();
  private problems = new Map<string, string>();
  private warnings = new Map<string, string>();
  private revision = 0;
  private readonly loadId = randomUUID();

  async register(config: FlowRegistrationConfig, input: FlowDefinition) {
    const id = parse(contributionIdSchema, config.flowId);
    const definition = parse(definitionSchema, input);
    const code = await readFile(config.entry, "utf8");
    validateFlowSource(code, {
      allowRootOperations: Boolean(config.plugin),
    });
    // Conversion happens at registration so unsupported schemas fail before use.
    z.toJSONSchema(definition.input);
    z.toJSONSchema(definition.output);
    if (
      this.loaded.has(id) &&
      this.loaded.get(id)?.plugin?.id !== config.plugin?.id
    )
      throw new FlowError(`Contribution ID already owned: ${id}`, 409);
    this.loaded.set(id, {
      id,
      title: definition.title,
      description: definition.description,
      service: definition.service,
      revision: `${this.loadId}:${++this.revision}`,
      inputSchema: definition.input,
      outputSchema: definition.output,
      concurrency: definition.concurrency,
      stepLimit: definition.stepLimit,
      agentTimeoutMs: definition.agentTimeoutMs,
      agentDefaults: definition.agentDefaults,
      plugin: config.plugin,
      legacyIdentity: Boolean(config.legacyRevision),
      permissions: Object.freeze([...(config.permissions ?? [])]),
      run: definition.run,
    });
    this.problems.delete(id);
    this.warnings.delete(id);
    this.sources.set(id, {
      id,
      code,
      revision: `${this.loadId}:${this.revision}`,
    });
  }

  source(id: string): FlowSource {
    this.get(id);
    return { ...this.sources.get(id)! };
  }

  get(id: string): LoadedFlow {
    const flow = this.loaded.get(id);
    if (!flow) {
      const problem = this.problems.get(id);
      throw new FlowError(problem ?? `Flow 不存在：${id}`, problem ? 422 : 404);
    }
    return flow;
  }

  has(id: string): boolean {
    return this.loaded.has(id);
  }

  remove(id: string) {
    this.loaded.delete(id);
    this.sources.delete(id);
    this.problems.delete(id);
    this.warnings.delete(id);
  }

  problem(id: string, message: string) {
    this.loaded.delete(id);
    this.sources.delete(id);
    this.problems.set(id, message);
  }

  clearProblem(id: string) {
    this.problems.delete(id);
  }

  reloadProblem(id: string, message: string) {
    if (this.loaded.has(id)) this.warnings.set(id, message);
  }

  clearReloadProblem(id: string) {
    this.warnings.delete(id);
  }

  catalog(): FlowCatalogEntry[] {
    const valid = [...this.loaded.values()].map((flow) => ({
      id: flow.id,
      title: flow.title,
      description: flow.description,
      available: true,
      revision: flow.revision,
      inputSchema: z.toJSONSchema(flow.inputSchema) as JsonValue,
      outputSchema: z.toJSONSchema(flow.outputSchema) as JsonValue,
      service: flow.service,
      ...(flow.agentDefaults ? { agentDefaults: flow.agentDefaults } : {}),
      ...(flow.plugin ? { plugin: flow.plugin } : {}),
      ...(this.warnings.has(flow.id)
        ? { error: this.warnings.get(flow.id) }
        : {}),
    }));
    const broken = [...this.problems].map(([id, error]) => ({
      id,
      title: id,
      description: "",
      available: false,
      error,
    }));
    return [...valid, ...broken].sort((a, b) => a.id.localeCompare(b.id));
  }
}
