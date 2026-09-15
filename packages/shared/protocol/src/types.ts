/** Text-only message accepted by the demo HTTP endpoint. */
export type ChatMessage = { role: "user" | "assistant"; text: string };

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

export interface FlowCatalogEntry {
  id: string;
  title: string;
  description: string;
  available: boolean;
  sourceHash?: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  agentDefaults?: FlowAgentOptions;
  error?: string;
}
export interface FlowCatalog {
  flows: FlowCatalogEntry[];
  actions?: FlowCatalogEntry[];
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
export type FlowStep =
  FlowAgentStep | FlowActionStep | FlowMemoStep | FlowCheckpointStep;

export interface ActionRun {
  id: string;
  requestId: string;
  actionId: string;
  sourceHash: string;
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
