import type { FlowCatalogEntry, JsonValue } from "@aura/protocol/types";
import type {
  ActionRegistration,
  ActionRegistrationConfig,
} from "./action-api.ts";
import { hashFlowDirectory } from "./registry.ts";
import { contributionIdSchema, FlowError, jsonValue, parse } from "./schema.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { AuraPluginIdentity } from "@aura/protocol/types";

export interface LoadedAction extends ActionRegistration {
  id: string;
  sourceHash: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  toolName: string;
  plugin?: AuraPluginIdentity;
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
      tool.timeoutMs! > 600_000
    )
      throw new FlowError("Action timeoutMs 必须在 1 到 600000 毫秒之间。");
    const inputSchema = jsonValue(tool.parameters, "Action input schema");
    const outputSchema = jsonValue(tool.output.schema, "Action output schema");
    const sourceHash = await hashFlowDirectory(config.directory);
    this.loaded.set(id, {
      ...definition,
      id,
      title,
      description,
      sourceHash,
      inputSchema,
      outputSchema,
      toolName: dshToolName,
      plugin: config.plugin,
    });
    this.problems.delete(id);
    this.warnings.delete(id);
  }

  snapshot(): ReadonlyMap<string, LoadedAction> {
    return new Map(this.loaded);
  }
  get(id: string): LoadedAction {
    const action = this.loaded.get(id);
    if (!action)
      throw new FlowError(
        this.problems.get(id) ?? `Action 不存在：${id}`,
        this.problems.has(id) ? 422 : 404,
      );
    return action;
  }
  sourceHash(id: string) {
    return this.loaded.get(id)?.sourceHash;
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
          sourceHash,
          inputSchema,
          outputSchema,
          plugin,
        }) => ({
          id,
          title,
          description,
          sourceHash,
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
