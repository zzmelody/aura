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

/** One request to start a plugin service Flow, before Aura creates its Run. */
export interface ServiceAdmission {
  /** Canonical Flow ID, `<plugin-id>/<local-id>`. */
  readonly flowId: string;
  /** Client idempotency key; the same requestId always maps to the same Run. */
  readonly requestId: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
}

export interface CapabilityProvider {
  /** Local IDs of this plugin's service Flows whose requests this provider admits and projects. */
  readonly serves?: readonly string[];
  /**
   * Validates a service request and returns the Flow input to start with. Must
   * be idempotent by requestId. Throw an Error whose message is a lowercase
   * snake_case code (e.g. "worker_busy") to refuse; clients see only that code.
   */
  admit?(request: ServiceAdmission): Promise<JsonValue> | JsonValue;
  /** Bounded plugin-specific projection of one root service Run, returned to clients as `view`. */
  view?(run: FlowRun): Promise<JsonValue> | JsonValue;
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
