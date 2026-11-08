import type { PluginLocalization } from "./localization.ts";
import type { ApiErrorDetails, FlowFailureDetails } from "./errors.ts";

/** Text-only message accepted by the demo HTTP endpoint. */
/** One conversation turn; user turns may attach uploaded image asset IDs. */
export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  images?: string[];
};
/** Images sent with one message; the model sees at most this many per request. */
export const CHAT_IMAGE_LIMIT = 4;

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
/** Plugin-owned transient display descriptor; consumers validate known codes and fields. */
export interface SiteStatusMessage {
  code: string;
  params?: Record<string, string | number>;
}
export interface SiteStatus {
  state: SiteStatusState;
  project?: SiteProject;
  message?: string;
  messageDetails?: SiteStatusMessage;
  output?: string;
  pid?: number;
  previewReady?: boolean;
  portMessage?: string;
  portDetails?: SiteStatusMessage[];
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
  provider: string;
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
  /** Display projection only; never stored in the attempt record. */
  errorDetails?: FlowFailureDetails;
}
export interface FlowRecoveryEvent {
  at: number;
  reason: string;
  /** Transient display projection; persisted recovery events keep their old shape. */
  reasonDetails?: ApiErrorDetails;
  action?: "retry" | "submit_output" | "terminate";
  requestId?: string;
}
export type FlowMode = "demo" | "codex" | "lumina" | "custom";

export interface AiCustomProvider {
  name: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseURL: string;
  images: boolean;
  contextWindow: number;
}
export interface AiModelSettings {
  mode: "codex" | "lumina" | "custom";
  model: string;
  reasoningEffort: string;
  custom?: AiCustomProvider;
}

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
  /** Manifest `description`, shown on the plugins page. */
  description?: string;
  /** Manifest-only display resources; excluded from durable plugin identity. */
  localization?: PluginLocalization;
  error?: string;
  errorDetails?: ApiErrorDetails;
}

/** Persisted trusted-local plugin entry. Paths are interpreted by the backend. */
export interface AuraPluginConfigurationEntry {
  path: string;
  enabled: boolean;
  trust: "local";
  /** Opaque plugin-owned JSON passed to its backend as `host.settings`. */
  settings?: JsonValue;
}

export interface AuraPluginConfiguration {
  version: 1;
  plugins: AuraPluginConfigurationEntry[];
}

/** Editable projection returned by the local runtime configuration endpoint. */
export interface AuraPluginSettingsEntry extends AuraPluginConfigurationEntry {
  status: AuraPluginStatus;
  /** Shipped in the repository `plugins/` root rather than added by path. */
  builtin: boolean;
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

/**
 * One enabled plugin's prebuilt browser bundle. The bundle registers itself
 * through DSH's lazy-CJS module loader under `module` and contributes
 * workbench pages when the workbench applies it.
 */
export interface AuraPluginPageBundle {
  plugin: AuraPluginIdentity;
  /** Browser module ID; equals the plugin ID. */
  module: string;
  /** Content revision; changes whenever the built bundle changes. */
  rev: string;
  /** Runtime-relative DSH combo reference, e.g. `plugins/??<id>/client.js&rev=<rev>`. */
  url: string;
}

/**
 * Page bundles of every enabled plugin plus the DSH module loader bundle.
 * `rev` changes whenever a bundle is added, removed or rebuilt, so an open
 * workbench can reconcile its mounted plugins.
 */
export interface AuraPluginPagesState {
  rev: string;
  loader: { module: string; rev: string; url: string };
  bundles: AuraPluginPageBundle[];
}

export interface FlowCatalogEntry {
  id: string;
  title: string;
  description: string;
  available: boolean;
  sourceHash?: string;
  /** Opaque load token for preview cache invalidation; never a code fingerprint. */
  revision?: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  agentDefaults?: FlowAgentOptions;
  /** Explicit opt-in for invocation by external HTTP service clients. */
  service?: boolean;
  plugin?: AuraPluginIdentity;
  error?: string;
  /** Transient display metadata, excluded from execution catalogs. */
  errorDetails?: ApiErrorDetails;
}
export interface FlowCatalog {
  flows: FlowCatalogEntry[];
  actions?: FlowCatalogEntry[];
  plugins?: AuraPluginStatus[];
  presets: Array<{
    id: string;
    name: string;
    description: string;
    unavailable: boolean;
  }>;
}
/** Entry source of the currently registered revision, for static UI previews. */
export interface FlowSource {
  id: string;
  code: string;
  sourceHash?: string;
  revision?: string;
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
  /** Display projection only; never stored in the step record. */
  errorDetails?: FlowFailureDetails;
  startedAt?: number;
  finishedAt?: number;
}
export interface ActionReference {
  id: string;
  sourceHash?: string;
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
  sourceHash?: string;
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
  sourceHash?: string;
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
  /** Conversation that explicitly started this run; absent on older records. */
  conversationId?: string;
  flow: {
    id: string;
    title: string;
    description: string;
    sourceHash?: string;
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
  /** Display projection only; never stored in the Run record. */
  errorDetails?: FlowFailureDetails;
  durableVersion?: 1;
  /** Frozen Run defaults, including environment-derived model selection. */
  agentDefaults?: FlowAgentConfig;
  requestInputHash?: string;
  actionVersions?: ActionReference[];
  queuedAt?: number;
  updatedAt?: number;
  recoveryEvents?: FlowRecoveryEvent[];
  /** Command receipts commit with the state change, never before it. */
  commands?: Array<{
    requestId: string;
    fingerprint: string;
    status: FlowRunPhase;
    at: number;
  }>;
  /** Present only for an engine-managed nested Flow Run. */
  parent?: FlowParentReference;
  /** Top-level Run of this tree; absent on the root itself. */
  rootRunId?: string;
  /** Last small progress value the Flow reported, at most 4 KiB. */
  report?: JsonValue;
  /** When the owning plugin's providers were told this root Run ended. */
  settledAt?: number;
  /** Canonical Flow ids above this Run, used for cycle and depth checks. */
  ancestry?: string[];
}
export interface FlowRunSummary {
  id: string;
  conversationId?: string;
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
  kind: "image" | "model" | "video" | "audio" | "subtitle";
  format: "png" | "jpeg" | "webp" | "glb" | "mp4" | "wav" | "srt";
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Measured playback length for audio artifacts. */
  durationSeconds?: number;
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
  entries: Array<{
    seq: number;
    kind: "user" | "assistant" | "tool" | "event";
    text: string;
  }>;
}

/** POST /chat body; credentials are configured on the server, never here. */
export type ChatModelSelection = { model?: string; reasoningEffort?: string };
/** Model controls captured when sending guidance to a running conversation. */
export type CodingSteerModelConfig = {
  mode: FlowMode;
  selection: ChatModelSelection;
};
export type ConversationModelConfig = Partial<
  Record<FlowMode, ChatModelSelection>
>;
/**
 * DSH permission preset of one coding conversation: the sandbox mode plus its
 * approval policy. `danger-full-access` lifts the sandbox and never prompts.
 */
export type CodingPermission =
  "read-only" | "workspace-write" | "danger-full-access";
export type CodingRunIntent = "plan" | "execute" | "goal" | "resume-goal";
export type CodingCollaborationAction = "plan" | "execute" | "clear-goal";

export interface CodingGoalInfo {
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  armed: boolean;
  roundsStarted: number;
  maxGoalRounds: number;
}

export interface CodingCollaboration {
  planning: boolean;
  goal?: CodingGoalInfo;
}
export type ChatModelInfo = {
  id: string;
  name: string;
  reasoningEfforts: Array<{ id: string; name: string }>;
  defaultReasoningEffort?: string;
  /** Model vendor label used to group gateway catalogs, e.g. "Anthropic". */
  vendor?: string;
};
export type ChatModelCatalog = {
  mode: FlowMode;
  defaultModel: string;
  models: ChatModelInfo[];
};
export type ChatRequest = {
  sessionId: string;
  messages: ChatMessage[];
  /** Applies only to this chat request, never to a tool-started Flow. */
  modelConfig?: ChatModelSelection;
};

/** One newline-delimited server event. A done event confirms completion. */
/** A Flow run the chat model started through a tool call. */
export interface ChatWorkflowStart {
  flowId: string;
  title: string;
  runId: string;
  /** Short human-readable record of the arguments the model chose. */
  inputPreview: string;
}
export type ChatEvent =
  | { type: "delta"; text: string }
  | ({ type: "workflow" } & ChatWorkflowStart)
  | ({ type: "error"; message: string } & Partial<ApiErrorDetails>)
  | { type: "done"; engine: "deepseek-harness"; mode: "demo" }
  | {
      type: "done";
      engine: "deepseek-harness";
      mode: "codex-subscription" | "lumina" | "custom";
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
  | {
      state: "error";
      message: string;
      model: string;
      messageDetails?: ApiErrorDetails;
    }
  | {
      state: "pending";
      method: "browser" | "device_code";
      authUrl?: string;
      verificationUri?: string;
      userCode?: string;
      message?: string;
      messageDetails?: ApiErrorDetails;
      prompt?: {
        kind: "text" | "secret";
        message: string;
        placeholder?: string;
      };
      model: string;
    };

/** A project directory a coding conversation runs in. */
/** User-invocable DSH skills; instruction bodies and paths stay on the host. */
export interface CodingSkillInfo {
  name: string;
  description: string;
}

export interface CodingProjectInfo {
  id: string;
  /** Canonical absolute directory; becomes the session's sandbox write root. */
  directory: string;
  title: string;
  /** Runtime-owned directory used when no project is selected. */
  isDefault?: true;
  /** `missing-dir` flags a directory that was moved or removed after creation. */
  status?: "ok" | "missing-dir";
}

/** One independently resumable branch of a coding conversation. */
export interface WorkspaceTerminalInfo {
  id: string;
  projectId: string;
  title: string;
  directory: string;
  createdAt: number;
  status: "running" | "exited" | "error";
  activity: "idle" | "busy" | "unknown";
  exitCode?: number;
}

export interface WorkspaceTerminalOutput {
  terminal: WorkspaceTerminalInfo;
  data: string;
  cursor: number;
  reset: boolean;
}

export interface CodingSideConversationInfo {
  id: string;
  title: string;
  createdAt: number;
  modelConfig?: ConversationModelConfig;
  /** Chosen permission preset; omitted inherits the parent's. */
  permission?: CodingPermission;
}

/** One coding conversation listed under a project. */
export interface CodingConversationInfo {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  /** Legacy first-side identity, retained for older clients and records. */
  sideSessionId?: string;
  sideConversations?: CodingSideConversationInfo[];
  modelConfig?: ConversationModelConfig;
  sideModelConfig?: ConversationModelConfig;
  /** Chosen permission preset; omitted leaves the DSH session preset in effect. */
  permission?: CodingPermission;
  /** Source of a fork or an explicit continuation in another project. */
  sourceSessionId?: string;
  /**
   * Outcome of the last stored turn, omitted when the conversation has no
   * turns or its session log is not readable. The frontend uses this to show
   * sidebar badges without loading full history.
   */
  lastTurnStatus?: "running" | "complete" | "stopped" | "error";
  /** Set while the running turn waits for the user to answer a question. */
  waitingForAnswer?: true;
}

export interface PersonalAssistantInfo {
  conversation: CodingConversationInfo;
  project: CodingProjectInfo;
}

/** One entry in the coding activity stream. */
export interface CodingTurnUsage {
  totalTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type CodingActivity =
  | CodingCapabilityActivity
  | { type: "usage"; usage: CodingTurnUsage }
  | { type: "turn-boundary"; endSeq: number }
  | ({ type: "workflow" } & ChatWorkflowStart)
  | {
      type: "tool";
      phase: "start";
      callId: string;
      name: string;
      /** The file, command or pattern the call touches, when it names one. */
      detail?: string;
      /** Session event time (ms); feeds the trajectory timeline. */
      at: number;
    }
  | {
      type: "tool";
      phase: "end";
      callId: string;
      ok: boolean;
      /** Applied hunks of a write or edit, for the file-change card. */
      diffs?: CodingFileDiff[];
      at: number;
    }
  /** A model request opened (step start) or answered (assistant message). */
  | { type: "model"; phase: "start" | "end"; at: number }
  | { type: "progress"; done: number; total: number }
  | { type: "deliverable"; path: string }
  /** Guidance the user sent into this turn while it was already running. */
  | {
      type: "steer";
      text: string;
      at: number;
      requestId?: string;
      /** Inbox status; omitted once the message enters the model context. */
      delivery?: "queued" | "canceled";
    }
  | {
      type: "question";
      questionId: string;
      questions: CodingQuestionItem[];
    }
  /** Only in replayed history: the answer the user gave to a question. */
  | {
      type: "answered";
      questionId: string;
      answers: CodingQuestionAnswer[];
    };

/** One question the agent is asking the user. */
export interface CodingQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** `plan-review`: `detail` is a plan and `approve` names the approving option. */
  intent?: { kind: "plan-review"; approve: string };
  /** `approval`: a grant-once-or-refuse decision; free text is not accepted. */
  kind?: "approval";
  /** Structured approval facts the client localizes; `question`/`detail` stay as fallback. */
  approval?: CodingApprovalFacts;
}

/** What an approval asks for, kept apart from any display language. */
export interface CodingApprovalFacts {
  toolName: string;
  /** Sandbox mode requested by a `escalate sandbox to <mode>: <why>` reason. */
  escalation?: string;
  /** The asker's reason; for an escalation, only the `<why>` part. */
  reason?: string;
  /** DSH's localized presentation of the reason, keyed by locale; live only. */
  displayReason?: Record<string, string>;
}

/** One request in a replayed coding conversation and everything it produced. */
export interface CodingHistoryTurn {
  /** Stable identity derived from the native turn/start log position. */
  turnId?: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  /** DSH log position of this completed turn, used to fork its context. */
  endSeq?: number;
  status: "running" | "complete" | "stopped" | "error";
  error?: string;
  /** Optional live display metadata; stored DSH history remains unchanged. */
  errorDetails?: ApiErrorDetails;
  /** The same events a live turn streams, in log order. */
  events: Array<{ type: "delta"; text: string } | CodingActivity>;
}

/** A turn-aligned history window with an optional stable backwards cursor. */
export interface CodingHistoryPage {
  turns: CodingHistoryTurn[];
  running: boolean;
  collaboration?: CodingCollaboration;
  hasMore: boolean;
  beforeSeq?: number;
  throughSeq?: number;
}

/** The user's answer to one question in a coding session. */
export interface CodingQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

/** One applied hunk; `oldText` is null for a new or overwritten file. */
export interface CodingFileDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/** Explicit grants for moving a built-in product into a trusted local plugin. */
export interface PluginCompatibility {
  flows?: Record<string, { from: string[]; to: string }>;
  actions?: Record<string, { from: string[]; to: string }>;
  presets?: string[];
  storageDomains?: string[];
  directories?: string[];
  rpcPrefixes?: string[];
}
export interface PluginHttpContribution {
  entry: string;
  mounts: string[];
}

/**
 * Automation task timing, mirroring DSH Schedule's record kinds. `after` is a
 * relative one-shot DSH keeps for model-created reminders.
 */
export type AutomationTiming =
  | { kind: "at"; at: string }
  | { kind: "after"; afterSeconds: number }
  | { kind: "every"; everySeconds: number }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; time: string; timeZone: string; weekdays: number[] }
  | { kind: "cron"; expression: string; timeZone: string };

/** One DSH Schedule task bound to a coding conversation. */
export interface AutomationTask {
  id: string;
  sessionId: string;
  /** Owning workspace and conversation title, when the conversation still exists. */
  projectId?: string;
  conversationTitle?: string;
  title: string;
  prompt: string;
  timing: AutomationTiming;
  /** Next occurrence (ISO). Meaningless once `status` is `ended`. */
  scheduledAt: string;
  /** DSH keeps `active`/`inactive`; a finished one-shot is `ended`. */
  status: "active" | "ended";
  lastDeliveredAt?: string;
}

/** Timing the create and edit forms submit; `after` is model-only. */
export type AutomationTimingInput = Exclude<
  AutomationTiming,
  { kind: "after" }
>;

export interface AutomationTaskInput {
  sessionId: string;
  title: string;
  prompt: string;
  timing: AutomationTimingInput;
}

export interface AutomationDelivery {
  scheduledAt: string;
  deliveredAt: string;
  prompt?: string;
}

export interface AutomationHistory {
  records: AutomationDelivery[];
  /** Older deliveries were pruned by retention or predate history. */
  truncated: boolean;
}

/** Conversation feature settings and request ledger diagnostics. */
export interface CodingCapabilities {
  revision: number;
  autoCompact: boolean;
  web: boolean;
  subagents: boolean;
  usedRequests: number;
  unknownRequests: number;
  hasWebKey: boolean;
}

export interface CodingCompactionResult {
  compacted: boolean;
  replacedMessages: number;
  previousTokens: number;
  savedTokens?: number;
}

export interface CodingSubagent {
  id: string;
  label: string;
  role: string;
  /** Identifies host-generated display text without interpreting a user label. */
  defaultLabel?: true;
  roleKind?: "review" | "research" | "agent";
  status: "running" | "complete" | "stopped" | "error" | "unknown";
  result: string;
  durationMs?: number;
  /** Safe execution failure, independent of whether the record was readable. */
  executionError?: string;
  executionErrorDetails?: ApiErrorDetails;
  /** A read failure does not establish the execution outcome. */
  recordError?: string;
  recordErrorDetails?: ApiErrorDetails;
}

export type CodingCapabilityActivity =
  | {
      type: "notice";
      id: string;
      text: string;
      details?: ApiErrorDetails;
      at: number;
    }
  | {
      type: "web";
      callId: string;
      sources: Array<{ url: string; title: string }>;
      truncated: boolean;
      statusCode?: number;
      at: number;
    };
export type * from "./integrations.ts";
