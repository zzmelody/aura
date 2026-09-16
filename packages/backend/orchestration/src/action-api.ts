import type { Context, Plugin } from "@deepseek-ai/cordis";
import {
  defineTool,
  type DefineToolOptions,
  type InferArgs,
  type InferValue,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
  type ValueSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import type { FlowMode } from "@aura/protocol/types";
import type { AuraPluginIdentity } from "@aura/protocol/types";
import type { JsonValue } from "@aura/protocol/types";
import { jsonValue } from "./schema.ts";
import type { LocalAIClient } from "./local-ai/api.ts";

export type { InferArgs, InferValue, ParameterSchemaSpec, ValueSchemaSpec };

/** Host-owned, manifest-gated capabilities available to trusted Actions. */
export interface AuraCapabilityClient {
  invoke(
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue>;
}

// DSH's recursively inferred schema types exceed TS's comparison depth when
// instantiated inside another generic factory. Keep author inference in defineAction.
const compileTool = defineTool as unknown as (
  options: unknown,
) => ToolDefinition;

/** Context for trusted backend code. Deliberately has no Flow/Agent invocation API. */
export interface ActionContext {
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly directory: string;
  readonly callId: string;
  readonly mode: FlowMode;
  readonly runId?: string;
  readonly stepId?: string;
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
  /** Host-owned local model lifecycle; absent in hosts without this capability. */
  readonly localAI?: LocalAIClient;
  /** Host-owned external service ports. Credentials never enter Action input. */
  readonly aura?: AuraCapabilityClient;
}

export type ActionBinding = Omit<
  ActionContext,
  "signal" | "callId" | "directory"
>;

export type ActionDefinition<
  S extends ParameterSchemaSpec,
  O extends ValueSchemaSpec,
> = Omit<DefineToolOptions<S, O>, "name" | "execute"> & {
  title: string;
  recovery?: "manual" | "idempotent";
  execute(
    context: ActionContext,
    input: InferArgs<S>,
  ): Promise<InferValue<NoInfer<O>>>;
};

export interface ActionRegistrationConfig {
  actionId: string;
  directory: string;
  entry: string;
  plugin?: AuraPluginIdentity;
  capabilities?: string[];
}

export interface ActionRegistration {
  title: string;
  description: string;
  recovery?: "manual" | "idempotent";
  tool(name: string, binding: ActionBinding): ToolDefinition;
}

export interface ActionRegistrationPort {
  register(
    config: ActionRegistrationConfig,
    definition: ActionRegistration,
  ): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    auraActionRegistry: ActionRegistrationPort;
  }
}

/** Directory supplies the Action id; DSH owns schema compilation and tool execution. */
export function defineAction<
  const S extends ParameterSchemaSpec,
  const O extends ValueSchemaSpec,
>(definition: ActionDefinition<S, O>): Plugin.Object<ActionRegistrationConfig> {
  if (
    typeof definition.execute !== "function" ||
    typeof definition.output?.render !== "function"
  )
    throw new TypeError("Action 必须提供 execute 和 output.render 函数。");
  return {
    name: `aura-action:${definition.title}`,
    inject: ["auraActionRegistry"],
    async apply(ctx: Context, config: ActionRegistrationConfig) {
      await ctx.auraActionRegistry.register(config, {
        title: definition.title,
        description: definition.description,
        recovery: definition.recovery ?? "manual",
        tool(name, binding) {
          const options = {
            ...definition,
            name,
            timeoutMs: definition.timeoutMs ?? 30_000,
            async execute(input: InferArgs<S>, exec: ToolRunContext) {
              jsonValue(input, "Action 入参");
              const output = await definition.execute(
                Object.freeze({
                  ...binding,
                  directory: config.directory,
                  signal: exec.signal,
                  callId: exec.callId,
                }),
                input,
              );
              return jsonValue(output, "Action 出参");
            },
          };
          // Author inference is retained above; erase generics only at the plugin boundary.
          return compileTool(options);
        },
      });
    },
  };
}
