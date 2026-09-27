/** Text-only message accepted by the demo HTTP endpoint. */
export type ChatMessage = { role: "user" | "assistant"; text: string };

export type SitePackageManager = "pnpm" | "npm" | "yarn" | "bun";
export interface SiteProject {
  /** Stable local identifier. For desktop sites this is the normalized directory. */
  id: string;
  directory: string;
  name: string;
  packageManager: SitePackageManager;
  scripts: string[];
  script: string;
  url: string;
}
export type SiteStatusState =
  "idle" | "starting" | "running" | "stopping" | "stopped" | "error";
export interface SiteStatus {
  state: SiteStatusState;
  project?: SiteProject;
  message?: string;
  output?: string;
  pid?: number;
  previewReady?: boolean;
  portMessage?: string;
}

/** Wire data only. Flow discovery, validation and execution live in the backend. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FlowRunPhase =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "waiting_input"
  | "needs_attention"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
/** Compatibility name for stored workspace messages; steps have their own phase. */
export type FlowPhase = FlowRunPhase;
export type FlowStepPhase =
  | "queued"
  | "running"
  | "waiting_input"
  | "unknown"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type FlowAttemptPhase =
  "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
export interface FlowRetry {
  maxAttempts: number;
  initialDelayMs?: number;
  multiplier?: number;
  maxDelayMs?: number;
}
/** Credential-free, per-Agent request controls. Provider remains bound to Run mode. */
export interface FlowAgentOptions {
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}
/** Frozen before dispatch; every attempt of a logical Agent uses this configuration. */
export interface FlowAgentConfig {
  provider: "openai-codex" | "deepseek-official";
  model: string;
  reasoningEffort: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs: number;
}
export interface FlowAttempt {
  number: number;
  status: FlowAttemptPhase;
  startedAt: number;
  finishedAt?: number;
  sessionId?: string;
  requestId?: string;
  error?: string;
}
export interface FlowRecoveryEvent {
  at: number;
  reason: string;
  action?: "retry" | "submit_output" | "terminate";
  requestId?: string;
}
export type FlowMode = "demo" | "codex";

export interface AuraPluginIdentity {
  id: string;
  name: string;
  version: string;
}

export interface AuraPluginStatus {
  id?: string;
  name: string;
  version?: string;
  enabled: boolean;
  available: boolean;
  error?: string;
}

/** Persisted trusted-local plugin entry. Paths are interpreted by the backend. */
export interface AuraPluginConfigurationEntry {
  path: string;
  enabled: boolean;
  trust: "local";
}

export interface AuraPluginConfiguration {
  version: 1;
  plugins: AuraPluginConfigurationEntry[];
}

/** Editable projection returned by the local runtime configuration endpoint. */
export interface AuraPluginSettingsEntry extends AuraPluginConfigurationEntry {
  status: AuraPluginStatus;
}

export interface AuraPluginSettingsState {
  configPath: string;
  plugins: AuraPluginSettingsEntry[];
  active: AuraPluginStatus[];
  /** The fixed config file changed outside this runtime and has not been applied yet. */
  applyRequired: boolean;
}

export interface AuraPluginSettingsUpdate {
  plugins: Array<Pick<AuraPluginConfigurationEntry, "path" | "enabled">>;
}

export interface FlowCatalogEntry {
  id: string;
  title: string;
  description: string;
  available: boolean;
  sourceHash?: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  agentDefaults?: FlowAgentOptions;
  /** Explicit opt-in for invocation by external HTTP service clients. */
  service?: boolean;
  plugin?: AuraPluginIdentity;
  error?: string;
}
export interface FlowCatalog {
  flows: FlowCatalogEntry[];
  actions?: FlowCatalogEntry[];
  plugins?: AuraPluginStatus[];
  presets: {
    id: string;
    name: string;
    description: string;
    unavailable: boolean;
  }[];
}
/** Entry source of the currently registered revision, for static UI previews. */
export interface FlowSource {
  id: string;
  code: string;
  sourceHash: string;
}
interface FlowStepBase {
  id: string;
  label: string;
  status: FlowStepPhase;
  /** Absent on pre-durable records. Local id remains available for display. */
  stepKey?: string;
  scopePath?: string[];
  requestHash?: string;
  attempts?: FlowAttempt[];
  retry?: FlowRetry;
  extraAttempts?: number;
  nextAttemptAt?: number;
  recoveryEvents?: FlowRecoveryEvent[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
export interface ActionReference {
  id: string;
  sourceHash: string;
  plugin?: AuraPluginIdentity;
}
export interface FlowAgentStep extends FlowStepBase {
  /** Absent only in records written before Action support. */
  kind?: "agent";
  preset: string;
  sessionId: string;
  requestId?: string;
  actions?: ActionReference[];
  /** Absent on records created before per-Agent configuration support. */
  config?: FlowAgentConfig;
  output?: string;
}
export interface FlowActionStep extends FlowStepBase {
  kind: "action";
  actionId: string;
  sourceHash?: string;
  plugin?: AuraPluginIdentity;
  input: JsonValue;
  output?: JsonValue;
  outputSchema?: JsonValue;
  recovery?: "manual" | "idempotent";
  idempotencyKey?: string;
}
export interface FlowMemoStep extends FlowStepBase {
  kind: "memo";
  outputSchema: JsonValue;
  output?: JsonValue;
}
export interface FlowCheckpointStep extends FlowStepBase {
  kind: "checkpoint";
  prompt: string;
  outputSchema: JsonValue;
  output?: JsonValue;
}
export interface FlowChildStep extends FlowStepBase {
  kind: "flow";
  /** Canonical registry id of the pinned child Flow revision. */
  flowId: string;
  sourceHash: string;
  plugin?: AuraPluginIdentity;
  input: JsonValue;
  outputSchema: JsonValue;
  /** Stable idempotency identity used to create or reclaim the child Run. */
  childRequestId: string;
  childRunId?: string;
  requestInputHash: string;
  output?: JsonValue;
}
export type FlowStep =
  | FlowAgentStep
  | FlowActionStep
  | FlowMemoStep
  | FlowCheckpointStep
  | FlowChildStep;

export interface FlowParentReference {
  runId: string;
  stepKey: string;
}

export interface ActionRun {
  id: string;
  requestId: string;
  actionId: string;
  sourceHash: string;
  plugin?: AuraPluginIdentity;
  input: JsonValue;
  output?: JsonValue;
  mode: FlowMode;
  status: FlowPhase;
  createdAt: number;
  finishedAt?: number;
  error?: string;
}
export interface FlowRun {
  id: string;
  requestId: string;
  flow: {
    id: string;
    title: string;
    description: string;
    sourceHash: string;
    plugin?: AuraPluginIdentity;
  };
  input: JsonValue;
  mode: FlowMode;
  status: FlowPhase;
  createdAt: number;
  finishedAt?: number;
  steps: FlowStep[];
  output?: JsonValue;
  error?: string;
  durableVersion?: 1;
  /** Frozen Run defaults, including environment-derived model selection. */
  agentDefaults?: FlowAgentConfig;
  requestInputHash?: string;
  actionVersions?: ActionReference[];
  queuedAt?: number;
  updatedAt?: number;
  recoveryEvents?: FlowRecoveryEvent[];
  /** Command receipts commit with the state change, never before it. */
  commands?: {
    requestId: string;
    fingerprint: string;
    status: FlowRunPhase;
    at: number;
  }[];
  /** Present only for an engine-managed nested Flow Run. */
  parent?: FlowParentReference;
  /** Canonical Flow ids above this Run, used for cycle and depth checks. */
  ancestry?: string[];
}
export interface FlowRunSummary {
  id: string;
  flowId: string;
  title: string;
  inputPreview: string;
  status: FlowPhase;
  mode: FlowMode;
  createdAt: number;
  updatedAt?: number;
}
/** A managed file reference. No filesystem paths or upstream URLs cross this boundary. */
export interface WorkflowArtifact {
  id: string;
  artifactId: string;
  runId: string;
  stepKey: string;
  attempt?: number;
  callId?: string;
  name: string;
  kind: "image" | "model" | "video";
  format: "png" | "jpeg" | "webp" | "glb" | "mp4";
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  thumbnailId?: string;
  status: "ready" | "unavailable" | "unsupported";
}
export interface WorkflowArtifacts {
  artifacts: WorkflowArtifact[];
  /** History admission is still running; poll even for a completed Run. */
  pending: boolean;
}
export interface FlowHistory {
  sessionId: string;
  preset: string;
  hasMore: boolean;
  beforeSeq?: number;
  entries: {
    seq: number;
    kind: "user" | "assistant" | "tool" | "event";
    text: string;
  }[];
}

/** POST /chat body; credentials are configured on the server, never here. */
export type ChatRequest = { sessionId: string; messages: ChatMessage[] };

/** One newline-delimited server event. A done event confirms completion. */
export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; engine: "deepseek-harness"; mode: "demo" }
  | {
      type: "done";
      engine: "deepseek-harness";
      mode: "codex-subscription";
      model: string;
    };

/** User-selectable OAuth flow supported by the Aura backend. */
export type CodexLoginRequest = { method: "browser" | "device_code" };

/** Manual callback URL or code requested by DSH's browser OAuth fallback. */
export type CodexLoginInputRequest = { input: string };

/** Public authentication state; OAuth credentials never cross this interface. */
export type CodexAuthStatus =
  | { state: "signed_out"; model: string }
  | { state: "authenticated"; model: string }
  | { state: "error"; message: string; model: string }
  | {
      state: "pending";
      method: "browser" | "device_code";
      authUrl?: string;
      verificationUri?: string;
      userCode?: string;
      message?: string;
      prompt?: {
        kind: "text" | "secret";
        message: string;
        placeholder?: string;
      };
      model: string;
    };

export type TripoRegion = "global" | "china";
export type TripoFeature = "text-to-model" | "image-to-model" | "task-status";

/** Credential-free capability status exposed by the backend. */
export interface TripoIntegrationStatus {
  configured: boolean;
  region: TripoRegion;
  apiVersion: "v3";
  features: TripoFeature[];
}

export interface TripoGenerationOptions {
  model?: string;
  texture?: boolean;
  pbr?: boolean;
  faceLimit?: number;
  textureQuality?: "standard" | "detailed";
  geometryQuality?: "standard" | "detailed";
  quad?: boolean;
  generateParts?: boolean;
}

export interface TripoTextToModelRequest extends TripoGenerationOptions {
  prompt: string;
  negativePrompt?: string;
}

export interface TripoImageToModelRequest extends TripoGenerationOptions {
  image: { url: string } | { fileToken: string };
}

export interface TripoCreateTaskResponse {
  taskId: string;
}

export type TripoTaskStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "unknown"
  | "banned"
  | "expired";

/** Stable projection of a Tripo task; undocumented upstream fields are omitted. */
export interface TripoTask {
  taskId: string;
  type: string;
  status: TripoTaskStatus;
  progress?: number;
  createdAt?: number;
  output?: {
    modelUrl?: string;
    modelUrls?: string[];
    baseModelUrl?: string;
    pbrModelUrl?: string;
    renderedImageUrl?: string;
    riggable?: boolean;
    rigType?: string;
  };
  error?: { code?: number; message?: string };
}
