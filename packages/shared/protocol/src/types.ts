/** Text-only message accepted by the demo HTTP endpoint. */
export type ChatMessage = { role: "user" | "assistant"; text: string };

/** Wire data only. Flow discovery, validation and execution live in the backend. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FlowPhase =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type FlowMode = "demo" | "codex";

export interface FlowCatalogEntry {
  id: string;
  title: string;
  description: string;
  available: boolean;
  sourceHash?: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
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
  status: FlowPhase;
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
  actions?: ActionReference[];
  output?: string;
}
export interface FlowActionStep extends FlowStepBase {
  kind: "action";
  actionId: string;
  sourceHash?: string;
  input: JsonValue;
  output?: JsonValue;
}
export type FlowStep = FlowAgentStep | FlowActionStep;

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
}
export interface FlowRunSummary {
  id: string;
  flowId: string;
  title: string;
  inputPreview: string;
  status: FlowPhase;
  mode: FlowMode;
  createdAt: number;
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
