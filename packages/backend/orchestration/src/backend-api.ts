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

/** Identity of one page call, supplied by the host, never by page input. */
export interface BackendCall {
  readonly signal: AbortSignal;
}

export interface BackendArtifact {
  readonly artifactId: string;
  readonly format: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
}

/** Host services handed to a plugin backend once, when Aura activates the plugin. */
export interface BackendHost {
  readonly pluginId: string;
  /** `<aura-root>/.aura/plugins/<plugin-id>/`, created by the host. */
  readonly dataDir: string;
  /** The plugin's `settings` from plugins.json, uninterpreted. Validate it yourself. */
  readonly settings: JsonValue | undefined;
  readonly workspace: { readonly cwd: string };
  /**
   * `<tempDir>/plugins/<plugin-id>/`, created by the host. Scratch space only:
   * it may be deleted at any time, so keep nothing here that must persist.
   */
  readonly tempDir: string;
  readonly storage: PluginStorage;
  readonly workflows: PluginWorkflows;
  readonly media: GeneratedArtifacts;
  /** Read-only view of this plugin's own Flow Runs. Other plugins' Runs are invisible. */
  readonly runs: {
    get(id: string): FlowRun | undefined;
    list(filter?: { flowId?: string; status?: readonly string[] }): FlowRun[];
  };
  /** Aura's content-addressed artifact store, shared with built-in producers such as Tripo. */
  readonly artifacts: {
    /** Stores bytes and returns their sha256 ID. Accepts PNG, JPEG, WebP, GLB, WAV and MP4. */
    put(bytes: Uint8Array, signal: AbortSignal): Promise<BackendArtifact>;
    /** Reads an artifact by ID and verifies its hash. Throws when missing or changed. */
    read(
      artifactId: string,
      signal: AbortSignal,
      limitBytes?: number,
    ): Promise<{ bytes: Buffer; artifact: BackendArtifact }>;
  };
  /** Admits a raster into the session attachment store so a Flow Agent can see it. */
  readonly attachments: {
    image(bytes: Uint8Array, name: string): Promise<JsonValue>;
  };
  /** Calls a built-in host capability, such as `aura.tripo.game-asset`. */
  invoke(
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  log(
    level: "info" | "warn" | "error",
    message: string,
    data?: JsonValue,
  ): void;
}

/** One request to start a plugin service Flow, before Aura creates its Run. */
export interface ServiceAdmission {
  /** Canonical Flow ID, `<plugin-id>/<local-id>`. */
  readonly flowId: string;
  /** Client idempotency key; the same requestId always maps to the same Run. */
  readonly requestId: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
}

/** What a plugin backend's `open(host)` returns. Every member is optional. */
export interface PluginBackend {
  /** Local IDs of this plugin's service Flows whose requests this backend admits and projects. */
  readonly serves?: readonly string[];
  /** Private objects bound to this plugin's Actions as `ctx.services`. */
  readonly services?: PluginServices;
  readonly chatTools?: readonly PluginTaskTool[];
  /** Historical output adapters return candidates; the host still verifies canonical files. */
  artifactCandidates?(
    output: unknown,
    producer: string,
  ): ReadonlyArray<{ path: string; name?: string; admitted: boolean }>;
  readonly requests?: {
    prefixes: readonly string[];
    handle(
      method: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<unknown>;
  };
  /**
   * Operations this plugin's own workbench pages may call. Anything not listed
   * is refused before `invoke` runs.
   */
  readonly pageOperations?: readonly string[];
  /** Handles one page operation listed in `pageOperations`. */
  invoke?(
    operation: string,
    input: JsonValue,
    call: BackendCall,
  ): Promise<JsonValue> | JsonValue;
  /**
   * Validates a service request and returns the Flow input to start with. Must
   * be idempotent by requestId. Throw an Error whose message is a lowercase
   * snake_case code (e.g. "worker_busy") to refuse; clients see only that code.
   */
  admit?(request: ServiceAdmission): Promise<JsonValue> | JsonValue;
  /** Bounded plugin-specific projection of one root service Run, returned to clients as `view`. */
  view?(run: FlowRun): Promise<JsonValue> | JsonValue;
  /**
   * Re-admits client data before a paused service Run resumes, e.g. a refreshed
   * scope. Refuse with a lowercase snake_case code. Without this hook a resume
   * carrying `input` is refused.
   */
  resume?(
    run: FlowRun,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<void> | void;
  /** Called once after a root Run of this plugin completes, fails, is cancelled or interrupted. */
  runSettled?(run: FlowRun): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface BackendDefinition {
  readonly kind: "aura-backend";
  open(host: BackendHost): Promise<PluginBackend> | PluginBackend;
}

/** Declares a plugin's backend. Module import must stay side-effect free. */
export function defineBackend(definition: {
  open: BackendDefinition["open"];
}): BackendDefinition {
  if (typeof definition?.open !== "function")
    throw new TypeError("Backend must define open(host).");
  return Object.freeze({ kind: "aura-backend", open: definition.open });
}

export function isBackendDefinition(
  value: unknown,
): value is BackendDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as BackendDefinition).kind === "aura-backend" &&
    typeof (value as BackendDefinition).open === "function"
  );
}
