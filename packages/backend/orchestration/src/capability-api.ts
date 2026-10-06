import type { FlowRun, JsonValue } from "@aura/protocol/types";

/** Run identity of one capability call, supplied by the host, never by plugin input. */
export interface CapabilityCall {
  readonly signal: AbortSignal;
  readonly runId?: string;
  /** Top-level Run of the calling Flow tree. Equals runId for a root Run. */
  readonly rootRunId?: string;
  readonly stepId?: string;
  readonly idempotencyKey?: string;
}

export interface CapabilityArtifact {
  readonly artifactId: string;
  readonly format: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
}

/** Host services handed to a provider once, when Aura activates its plugin. */
export interface CapabilityHost {
  readonly pluginId: string;
  /** `<aura-root>/.aura/plugins/<plugin-id>/`, created by the host. */
  readonly dataDir: string;
  /** The plugin's `settings` from plugins.json, uninterpreted. Validate it yourself. */
  readonly settings: JsonValue | undefined;
  /** Read-only view of this plugin's own Flow Runs. Other plugins' Runs are invisible. */
  readonly runs: {
    get(id: string): FlowRun | undefined;
    list(filter?: { flowId?: string; status?: readonly string[] }): FlowRun[];
  };
  /** Aura's content-addressed artifact store, shared with built-in producers such as Tripo. */
  readonly artifacts: {
    /** Stores bytes and returns their sha256 ID. Accepts PNG, JPEG, WebP, GLB, WAV and MP4. */
    put(bytes: Uint8Array, signal: AbortSignal): Promise<CapabilityArtifact>;
    /** Reads an artifact by ID and verifies its hash. Throws when missing or changed. */
    read(artifactId: string, signal: AbortSignal, limitBytes?: number): Promise<{ bytes: Buffer; artifact: CapabilityArtifact }>;
  };
  /** Admits a raster into the session attachment store so a Flow Agent can see it. */
  readonly attachments: {
    image(bytes: Uint8Array, name: string): Promise<JsonValue>;
  };
  /** Calls a built-in host capability. Plugin-contributed capabilities are not reachable. */
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

export interface CapabilityProvider {
  invoke(
    operation: string,
    input: JsonValue,
    call: CapabilityCall,
  ): Promise<JsonValue> | JsonValue;
  /** Called once after a root Run of this plugin completes, fails, is cancelled or interrupted. */
  runSettled?(run: FlowRun): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface CapabilityDefinition {
  readonly kind: "aura-capability";
  readonly title: string;
  open(host: CapabilityHost): Promise<CapabilityProvider> | CapabilityProvider;
}

/** Declares a plugin capability provider. Module import must stay side-effect free. */
export function defineCapability(definition: {
  title: string;
  open: CapabilityDefinition["open"];
}): CapabilityDefinition {
  if (typeof definition?.title !== "string" || !definition.title.trim())
    throw new TypeError("Capability title is required.");
  if (typeof definition.open !== "function")
    throw new TypeError("Capability must define open(host).");
  return Object.freeze({
    kind: "aura-capability",
    title: definition.title.trim(),
    open: definition.open,
  });
}

export function isCapabilityDefinition(
  value: unknown,
): value is CapabilityDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as CapabilityDefinition).kind === "aura-capability" &&
    typeof (value as CapabilityDefinition).open === "function"
  );
}
