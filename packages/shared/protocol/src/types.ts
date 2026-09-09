/** Text-only message accepted by the demo HTTP endpoint. */
export type ChatMessage = { role: "user" | "assistant"; text: string };

/** Wire data only. Validation, dependency resolution and execution live in the backend. */
export type FlowPhase =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped";
export interface FlowDefinition {
  id: string;
  name: string;
  nodes: {
    id: string;
    label: string;
    preset: string;
    prompt: string;
    dependsOn: string[];
  }[];
  coordinator: { preset: string; prompt: string; sources: string[] };
  concurrency: number;
  timeoutMs: number;
}
export interface SavedFlowDefinition {
  definition: FlowDefinition;
  revision: number;
  updatedAt: number;
}
export interface FlowCatalog {
  definitions: SavedFlowDefinition[];
  presets: {
    id: string;
    name: string;
    description: string;
    unavailable: boolean;
  }[];
}
export interface FlowStep {
  id: string;
  label: string;
  preset: string;
  sessionId: string;
  status: FlowPhase;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
export interface FlowRun {
  id: string;
  requestId: string;
  definition: FlowDefinition;
  revision: number;
  task: string;
  mode: "demo" | "codex";
  status: FlowPhase;
  createdAt: number;
  finishedAt?: number;
  steps: FlowStep[];
  report?: string;
  error?: string;
}
export interface FlowRunSummary {
  id: string;
  name: string;
  task: string;
  status: FlowPhase;
  mode: "demo" | "codex";
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
