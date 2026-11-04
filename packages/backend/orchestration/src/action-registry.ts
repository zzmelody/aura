import type { FlowCatalogEntry, JsonValue } from "@aura/protocol/types";
import type {
  ActionRegistration,
  ActionRegistrationConfig,
} from "./action-api.ts";
import { contributionIdSchema, FlowError, jsonValue, parse } from "./schema.ts";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { AuraPluginIdentity } from "@aura/protocol/types";

export interface LoadedAction extends ActionRegistration {
  id: string;
  sourceHash?: string;
  revision?: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  toolName: string;
  plugin?: AuraPluginIdentity;
  services?: Readonly<Record<string, unknown>>;
  retainServices?: () => () => void;
  permissions: readonly string[];
  legacyIdentity?: boolean;
  ownerPlugin?: AuraPluginIdentity;
}

function toolName(id: string): string {
  if (!id.includes("/")) return id;
  const readable = id.replace(/[^a-zA-Z0-9_]/gu, "_").slice(0, 48);
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 10);
  return `aura_${readable}_${suffix}`;
}

/** Stores definitions only. Model visibility is granted in an individual Agent scope. */
export class ActionRegistry {
  private loaded = new Map<string, LoadedAction>();
  private problems = new Map<string, string>();
  private warnings = new Map<string, string>();
  private revision = 0;
  private readonly loadId = randomUUID();
  private services: (pluginId: string) => Readonly<Record<string, unknown>> =
    () => ({});
  private retain: (pluginId: string) => () => () => void = () => () => () =>
    undefined;
  setServiceRetention(resolve: (pluginId: string) => () => () => void) {
    this.retain = resolve;
  }
  setServicesResolver(
    resolve: (pluginId: string) => Readonly<Record<string, unknown>>,
  ) {
    this.services = resolve;
  }
  private bind(action: LoadedAction): LoadedAction {
    return {
      ...action,
      services: action.plugin ? this.services(action.plugin.id) : undefined,
      retainServices: action.plugin ? this.retain(action.plugin.id) : undefined,
    };
  }

  async register(
    config: ActionRegistrationConfig,
    definition: ActionRegistration,
  ) {
    const id = parse(contributionIdSchema, config.actionId);
    parse(z.enum(["manual", "idempotent"]), definition.recovery ?? "manual");
    if (id === "run_code" || id.startsWith("aura_direct_"))
      throw new FlowError("Action ID 为内部保留名称。");
    const title = parse(z.string().trim().min(1).max(100), definition.title);
    const description = parse(
      z.string().trim().min(1).max(2_000),
      definition.description,
    );
    // defineTool performs DSH's native schema compilation before committing a version.
    const dshToolName = toolName(id);
    const tool = definition.tool(dshToolName, {
      cwd: process.env.AURA_FLOW_CWD ?? process.cwd(),
      mode: "demo",
    });
    if (
      !Number.isInteger(tool.timeoutMs) ||
      tool.timeoutMs! < 1 ||
      tool.timeoutMs! > 30 * 60_000
    )
      throw new FlowError("Action timeoutMs 必须在 1 到 1800000 毫秒之间。");
    const inputSchema = jsonValue(tool.parameters, "Action input schema");
    const outputSchema = jsonValue(tool.output.schema, "Action output schema");
    if (
      this.loaded.has(id) &&
      this.loaded.get(id)?.plugin?.id !== config.plugin?.id
    )
      throw new FlowError(`Contribution ID already owned: ${id}`, 409);
    this.loaded.set(id, {
      ...definition,
      id,
      title,
      description,
      revision: `${this.loadId}:${++this.revision}`,
      inputSchema,
      outputSchema,
      toolName: dshToolName,
      plugin: config.plugin,
      legacyIdentity: Boolean(config.legacyRevision),
      permissions: Object.freeze([...(config.permissions ?? [])]),
    });
    this.problems.delete(id);
    this.warnings.delete(id);
  }

  snapshot(): ReadonlyMap<string, LoadedAction> {
    return new Map(
      [...this.loaded].map(([id, action]) => [id, this.bind(action)]),
    );
  }
  get(id: string): LoadedAction {
    const action = this.loaded.get(id);
    if (!action)
      throw new FlowError(
        this.problems.get(id) ?? `Action 不存在：${id}`,
        this.problems.has(id) ? 422 : 404,
      );
    return this.bind(action);
  }
  has(id: string): boolean {
    return this.loaded.has(id);
  }
  remove(id: string) {
    this.loaded.delete(id);
    this.problems.delete(id);
    this.warnings.delete(id);
  }
  problem(id: string, error: string) {
    this.remove(id);
    this.problems.set(id, error);
  }
  clearProblem(id: string) {
    this.problems.delete(id);
  }
  reloadProblem(id: string, error: string) {
    if (this.loaded.has(id)) this.warnings.set(id, error);
  }
  clearReloadProblem(id: string) {
    this.warnings.delete(id);
  }
  catalog(): FlowCatalogEntry[] {
    return [
      ...[...this.loaded.values()].map(
        ({
          id,
          title,
          description,
          revision,
          inputSchema,
          outputSchema,
          plugin,
        }) => ({
          id,
          title,
          description,
          revision,
          inputSchema,
          outputSchema,
          ...(plugin ? { plugin } : {}),
          available: true,
          ...(this.warnings.has(id) ? { error: this.warnings.get(id) } : {}),
        }),
      ),
      ...[...this.problems].map(([id, error]) => ({
        id,
        title: id,
        description: "",
        available: false,
        error,
      })),
    ].sort((a, b) => a.id.localeCompare(b.id));
  }
}
