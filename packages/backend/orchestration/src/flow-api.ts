import type { Context, Plugin } from "@deepseek-ai/cordis";
import { z } from "zod";
import type { JsonValue } from "@aura/protocol/types";

export { z };

export type FlowMode = "demo" | "codex";

export interface FlowAgentRequest {
  id: string;
  label: string;
  preset: string;
  prompt: string;
  actions?: string[];
}

export interface FlowActionRequest {
  id: string;
  label?: string;
  action: string;
  input: unknown;
}

export interface FlowActionResult {
  stepId: string;
  actionId: string;
  output: JsonValue;
}

export interface FlowAgentResult {
  stepId: string;
  sessionId: string;
  output: string;
}

export interface FlowContext {
  readonly runId: string;
  readonly mode: FlowMode;
  readonly signal: AbortSignal;
  agent(request: FlowAgentRequest): Promise<FlowAgentResult>;
  action(request: FlowActionRequest): Promise<FlowActionResult>;
}

export interface FlowDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  title: string;
  description?: string;
  input: InputSchema;
  output: OutputSchema;
  concurrency?: number;
  agentTimeoutMs?: number;
  run(
    context: FlowContext,
    input: z.output<InputSchema>,
  ): Promise<z.input<OutputSchema>> | z.input<OutputSchema>;
}

export interface FlowRegistrationConfig {
  flowId: string;
  directory: string;
  entry: string;
}

export interface FlowRegistrationPort {
  register(
    config: FlowRegistrationConfig,
    definition: FlowDefinition,
  ): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    auraFlowRegistry: FlowRegistrationPort;
  }
}

/**
 * Defines one trusted JavaScript Flow while hiding its Cordis plugin adapter.
 * The containing directory supplies the public Flow id.
 */
export function defineFlow<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  definition: FlowDefinition<InputSchema, OutputSchema>,
): Plugin.Object<FlowRegistrationConfig> {
  return {
    name: `aura-flow:${definition.title}`,
    inject: ["auraFlowRegistry"],
    async apply(ctx: Context, config: FlowRegistrationConfig) {
      await ctx.auraFlowRegistry.register(config, definition);
    },
  };
}
