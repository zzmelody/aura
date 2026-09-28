import type { Context, Plugin } from "@deepseek-ai/cordis";
import { HarnessError } from "@deepseek-ai/dsh-llm";
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

export const ACTION_FAILURE_CODE = "ACTION_FAILURE";
const MAX_ACTION_FAILURE_MESSAGE = 2_000;

/**
 * A bounded, product-facing Action failure that may be persisted and shown in
 * Workflow UI. Authors must never include credentials, private paths, signed
 * URLs, or stack traces in this message.
 */
export class ActionFailure extends HarnessError {
  constructor(message: string, options?: ErrorOptions) {
    const normalized = message
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!normalized) throw new TypeError("ActionFailure message is required.");
    super(
      normalized.length > MAX_ACTION_FAILURE_MESSAGE
        ? `${normalized.slice(0, MAX_ACTION_FAILURE_MESSAGE - 1)}…`
        : normalized,
      ACTION_FAILURE_CODE,
      options,
    );
    this.name = "ActionFailure";
  }
}

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
  readonly attempt?: number;
  /** Registers generated files for this call without changing the Action's output schema. */
  readonly artifacts?: {
    register(
      path: string,
      options?: { name?: string; poster?: string },
    ): Promise<void>;
  };
  /** Host-owned local model lifecycle; absent in hosts without this capability. */
  readonly localAI?: LocalAIClient;
  /** Host-owned external service ports. Credentials never enter Action input. */
  readonly aura?: AuraCapabilityClient;
  /** Host-owned project/version service for built-in production Actions. */
  readonly videoProduction?: import("./video-library.ts").VideoLibrary;
  readonly contentProduction?: import("./content-library.ts").ContentLibrary;
  readonly topicLibrary?: import("./topic-library.ts").TopicLibrary;
  readonly contentAnalytics?: import("./content-analytics.ts").ContentAnalyticsLibrary;
}

export type ActionBinding = Omit<
  ActionContext,
  "signal" | "callId" | "directory"
> & {
  /** Host-only call-scoped adapters; never exposed to model/tool parameters. */
  bindCall?: (
    callId: string,
  ) => Pick<ActionContext, "localAI" | "aura" | "artifacts">;
};

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
              const { bindCall, ...contextBinding } = binding;
              const output = await definition.execute(
                Object.freeze({
                  ...contextBinding,
                  ...bindCall?.(exec.callId),
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
