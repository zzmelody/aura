import type { Context, Plugin } from "@deepseek-ai/cordis";
import { z } from "zod";
import type {
  AuraPluginIdentity,
  JsonValue,
  FlowRetry,
  FlowAgentOptions,
} from "@aura/protocol/types";
export type {
  FlowRetry,
  FlowAgentOptions,
  FlowAgentConfig,
} from "@aura/protocol/types";

export { z };

export type FlowMode = "demo" | "codex" | "lumina" | "custom";

/** Durable host-admitted raster reference; never a path, URL or base64 payload. */
export interface FlowImageReference {
  attachmentId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  width: number;
  height: number;
  name?: string;
  originalDimensions?: { width: number; height: number };
}

export interface FlowAgentRequest extends FlowAgentOptions {
  id: string;
  label: string;
  preset: string;
  prompt: string;
  images?: FlowImageReference[];
  actions?: string[];
  retry?: FlowRetry;
}

export interface FlowActionRequest {
  id: string;
  label?: string;
  action: string;
  input: unknown;
  retry?: FlowRetry;
}

export interface FlowActionResult {
  stepId: string;
  actionId: string;
  output: JsonValue;
  attempt?: number;
  recovered?: boolean;
}

export interface FlowChildRequest {
  id: string;
  label?: string;
  /** Canonical Flow id, including a plugin namespace when applicable. */
  flow: string;
  input: unknown;
}

export interface FlowChildResult {
  stepId: string;
  runId: string;
  flowId: string;
  output: JsonValue;
  recovered?: boolean;
}

export interface FlowAgentResult {
  stepId: string;
  sessionId: string;
  output: string;
  attempt?: number;
  recovered?: boolean;
}

export interface FlowContext {
  readonly runId: string;
  readonly mode: FlowMode;
  readonly signal: AbortSignal;
  sequence<T>(
    options: { id: string },
    run: (scope: FlowScope) => T | Promise<T>,
  ): Promise<T>;
}

export interface FlowScope extends FlowContext {
  agent(request: FlowAgentRequest): Promise<FlowAgentResult>;
  action(request: FlowActionRequest): Promise<FlowActionResult>;
  flow(request: FlowChildRequest): Promise<FlowChildResult>;
  parallel<B extends Record<string, (scope: FlowScope) => unknown>>(options: {
    id: string;
    branches: B;
  }): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
  memo<S extends z.ZodType>(request: {
    id: string;
    label?: string;
    schema: S;
    compute(): z.input<S> | Promise<z.input<S>>;
  }): Promise<z.output<S>>;
  checkpoint<S extends z.ZodType>(request: {
    id: string;
    label?: string;
    prompt: string;
    schema: S;
  }): Promise<z.output<S>>;
  /** Stores a small (≤4 KiB) last-wins progress value on the root Run. Not a step. */
  report(value: JsonValue): Promise<void>;
}

export interface FlowDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  title: string;
  description?: string;
  /** Publishes this Flow through the external HTTP invocation endpoint. */
  service?: boolean;
  input: InputSchema;
  output: OutputSchema;
  concurrency?: number;
  agentTimeoutMs?: number;
  /** Individual agent() options override these defaults. */
  agentDefaults?: FlowAgentOptions;
  run(
    context: FlowContext,
    input: z.output<InputSchema>,
  ): Promise<z.input<OutputSchema>> | z.input<OutputSchema>;
}

export interface FlowRegistrationConfig {
  flowId: string;
  directory: string;
  entry: string;
  plugin?: AuraPluginIdentity;
  /** Trusted local package root, never projected into public catalog DTOs. */
  pluginRoot?: string;
  capabilities?: string[];
  legacyRevision?: { from: string[]; to: string };
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
