import type { FlowMode, FlowRun, JsonValue } from "@aura/protocol/types";
import type { ParameterSchemaSpec } from "./action-api.ts";
import type { GeneratedArtifacts } from "./artifacts/generated.ts";
import type { ArtifactFile } from "./artifacts/http.ts";
import type { defineDomain } from "@deepseek-ai/dsh-storage-domain";

/** A trusted plugin's private, non-JSON services. Never included in page DTOs. */
export type PluginServices = Readonly<Record<string, unknown>>;

export interface PluginWorkflows {
  start(input: unknown): Promise<FlowRun>;
  get(id: string): FlowRun;
  runs: { entries(): IterableIterator<[string, FlowRun]> };
}

export interface PluginStorage {
  /** Collision-free prefix for new domain names. */
  readonly namespace: string;
  /** Defaults to plugin-prefixed domains; legacy names require a manifest grant. */
  open(spec: ReturnType<typeof defineDomain>): Promise<{
    table(name: string): unknown;
    close(): Promise<void>;
  }>;
  /** Historical sibling storage requires an explicit manifest grant. */
  directory(name: string): string;
}

export interface PluginTaskTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ParameterSchemaSpec;
  start(
    input: Record<string, unknown>,
    scope: { requestId: string; mode: FlowMode; signal: AbortSignal },
  ): Promise<{ runId: string; flowId: string; title: string; input: unknown }>;
}

/** Binary HTTP runs in the API process, outside the bounded JSON RPC channel. */
export interface PluginHttpHost {
  request<T>(method: string, input?: unknown, signal?: AbortSignal): Promise<T>;
  readonly artifacts: GeneratedArtifacts;
  artifactContent(
    descriptor: ArtifactFile,
    request: Request,
  ): Promise<Response>;
}

export interface PluginHttpDefinition {
  fetch(request: Request): Promise<Response> | Response;
  close?(): Promise<void> | void;
}

export type PluginRequest = (
  method: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<JsonValue>;
