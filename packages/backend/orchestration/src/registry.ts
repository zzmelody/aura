import { readFile } from "node:fs/promises";
import { hashContribution } from "./contribution-hash.ts";
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

export interface LoadedFlow {
  id: string;
  title: string;
  description: string;
  service: boolean;
  sourceHash: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  concurrency: number;
  agentTimeoutMs: number;
  agentDefaults?: FlowAgentOptions;
  plugin?: AuraPluginIdentity;
  capabilities: readonly string[];
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
    agentTimeoutMs: z.number().int().min(1_000).max(600_000).default(180_000),
    agentDefaults: agentOptionsSchema.optional(),
    run: z.custom<FlowDefinition["run"]>(
      (value) => typeof value === "function",
      { error: "run 必须是函数" },
    ),
  })
  .strict();

export { hashContribution as hashFlowDirectory } from "./contribution-hash.ts";

/** Last-known-good Flow registry populated by Loader-managed Flow plugins. */
export class FlowRegistry {
  private loaded = new Map<string, LoadedFlow>();
  private sources = new Map<string, FlowSource>();
  private problems = new Map<string, string>();
  private warnings = new Map<string, string>();

  async register(config: FlowRegistrationConfig, input: FlowDefinition) {
    const id = parse(contributionIdSchema, config.flowId);
    const definition = parse(definitionSchema, input);
    const sourceHash = await hashContribution(
      config.directory,
      config.pluginRoot,
    );
    const code = await readFile(config.entry, "utf8");
    validateFlowSource(code, {
      allowRootOperations: Boolean(config.plugin),
    });
    // Conversion happens at registration so unsupported schemas fail before use.
    z.toJSONSchema(definition.input);
    z.toJSONSchema(definition.output);
    this.loaded.set(id, {
      id,
      title: definition.title,
      description: definition.description,
      service: definition.service,
      sourceHash,
      inputSchema: definition.input,
      outputSchema: definition.output,
      concurrency: definition.concurrency,
      agentTimeoutMs: definition.agentTimeoutMs,
      agentDefaults: definition.agentDefaults,
      plugin: config.plugin,
      capabilities: Object.freeze([...(config.capabilities ?? [])]),
      run: definition.run,
    });
    this.problems.delete(id);
    this.warnings.delete(id);
    this.sources.set(id, { id, code, sourceHash });
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

  sourceHash(id: string) {
    return this.loaded.get(id)?.sourceHash;
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
      sourceHash: flow.sourceHash,
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
