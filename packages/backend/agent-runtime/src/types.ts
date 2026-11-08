import type {
  ChatMessage,
  ChatWorkflowStart,
  CodingCapabilityActivity,
  CodingCollaboration,
  CodingPermission,
  CodingRunIntent,
  CodingSideConversationInfo,
  CodingTurnUsage,
  ConversationModelConfig,
  FlowAgentConfig,
  FlowMode,
} from "@aura/protocol/types";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import type { ApiErrorDetails } from "@aura/protocol/errors";

export type Table<T> = Pick<
  KvTable<string, T>,
  "get" | "entries" | "put" | "delete" | "update"
>;

/** One chat request handled by the long-lived DSH host. */
export interface ChatTurn {
  sessionId?: string;
  messages: ChatMessage[];
  mode: FlowMode;
  /** Session-local overrides; never inherited by chat workflow tools. */
  model?: string;
  /** Resolved server-side for gateway modes; never accepted from a client. */
  defaults?: FlowAgentConfig;
  reasoningEffort?: string;
}
/** Streamed chat output: reply text or a workflow started by a tool call. */
export type ChatStreamEvent =
  { type: "delta"; text: string } | ({ type: "workflow" } & ChatWorkflowStart);

/** One turn of a persistent coding conversation bound to a project directory. */
export interface CodingTurn {
  requestId?: string;
  /** Aura-owned id of the coding conversation, stable across turns. */
  sessionId: string;
  /** Project the conversation belongs to; the backend resolves its directory. */
  projectId?: string;
  /**
   * Absolute project directory the sandbox confines writes to. Filled in by the
   * backend from the project record, never taken from a client.
   */
  project: string;
  prompt: string;
  /** Uploaded chat image asset IDs attached to this request. */
  images?: string[];
  /**
   * Set on a side chat: the indexed conversation it branches from. The first
   * turn forks that conversation's log; a side chat is never indexed.
   */
  forkFrom?: string;
  branchFrom?: string;
  /** Completed source turn's log position for an explicit fork. */
  branchAt?: number;
  /** Imported once, only when the conversation has no stored DSH log. */
  history?: ChatMessage[];
  context?: string;
  mode: FlowMode;
  model?: string;
  reasoningEffort?: string;
  /** Permission preset to apply before this turn; omitted keeps the saved one. */
  permission?: CodingPermission;
  intent?: CodingRunIntent;
  /** Resolved server-side for gateway modes; never accepted from a client. */
  defaults?: FlowAgentConfig;
}

/**
 * Streamed coding output. Beyond reply text it carries what the agent is
 * doing, so the transcript can show tool activity, task progress and files
 * the agent declared, rather than only its final answer.
 */
export type CodingStreamEvent =
  | CodingTimelineEvent
  | { type: "collaboration"; state: CodingCollaboration }
  | { type: "turn-start"; turnId: string; at: number };

export type CodingTimelineEvent =
  | CodingCapabilityActivity
  | { type: "usage"; usage: CodingTurnUsage }
  | { type: "turn-boundary"; endSeq: number }
  | ({ type: "workflow" } & ChatWorkflowStart)
  | { type: "delta"; text: string }
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
      delivery?: "queued" | "canceled";
    }
  | {
      type: "question";
      questionId: string;
      questions: CodingQuestion[];
    }
  /** Only in replayed history: the answer the user gave to a question. */
  | {
      type: "answered";
      questionId: string;
      answers: CodingQuestionAnswer[];
    };

/** One question the agent is asking the user. */
export interface CodingQuestion {
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
  endSeq?: number;
  status: "running" | "complete" | "stopped" | "error";
  error?: string;
  /** Read-only display projection from native execution outcomes. */
  errorDetails?: ApiErrorDetails;
  /** The same events a live turn streams, in log order. */
  events: CodingTimelineEvent[];
}

/** The user's answer to one question. */
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

/** A coding conversation as listed for one project. */
export interface CodingConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  sideSessionId?: string;
  sideConversations?: CodingSideConversationInfo[];
  modelConfig?: ConversationModelConfig;
  sideModelConfig?: ConversationModelConfig;
  /** Chosen permission preset; omitted leaves the DSH session preset in effect. */
  permission?: CodingPermission;
  sourceSessionId?: string;
  /** Outcome of the last stored turn; omitted when the session has no turns. */
  lastTurnStatus?: "running" | "complete" | "stopped" | "error";
  /** Set while the running turn waits for the user to answer a question. */
  waitingForAnswer?: true;
}
