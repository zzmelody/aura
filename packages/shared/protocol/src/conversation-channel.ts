import type { ApiErrorDetails } from "./errors.ts";
import type {
  ChatMessage,
  ChatModelSelection,
  CodingActivity,
  CodingCollaboration,
  CodingHistoryPage,
  CodingPermission,
  CodingQuestionAnswer,
  CodingRunIntent,
  CodingSteerModelConfig,
  FlowMode,
} from "./types.ts";

/** A submitted execution may contain several native DSH turns. */
export interface ConversationStart {
  projectId?: string;
  prompt: string;
  images?: string[];
  forkFrom?: string;
  branchFrom?: string;
  branchAt?: number;
  history?: ChatMessage[];
  context?: string;
  mode: FlowMode;
  modelConfig?: ChatModelSelection;
  permission?: CodingPermission;
  intent?: CodingRunIntent;
}

export type ConversationCommand = { commandId: string } & (
  | { type: "turn.start"; input: ConversationStart }
  | {
      type: "turn.steer";
      executionId: string;
      prompt: string;
      images?: string[];
      modelConfig?: CodingSteerModelConfig;
    }
  | { type: "turn.stop"; executionId: string }
  | {
      type: "question.answer";
      executionId: string;
      questionId: string;
      answers: CodingQuestionAnswer[];
    }
);

export interface ConversationExecution {
  id: string;
  commandId: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status:
    | "preparing"
    | "running"
    | "stopping"
    | "complete"
    | "stopped"
    | "error"
    | "interrupted";
  error?: string;
  errorStatus?: number;
  /** Transient UI projection; never part of the command ledger or model context. */
  errorDetails?: ApiErrorDetails;
  model?: string;
}

export interface ConversationReceipt {
  commandId: string;
  sessionId: string;
  executionId: string;
  status: "accepted" | "applied" | "rejected" | "uncertain";
  error?: string;
  /** Transient UI projection; legacy receipts keep their original error text. */
  errorDetails?: ApiErrorDetails;
  execution?: ConversationExecution;
}

export type ConversationActivity =
  | CodingActivity
  | { type: "delta"; text: string }
  | { type: "collaboration"; state: CodingCollaboration }
  | { type: "turn-start"; turnId: string; at: number };

export interface ConversationEvent {
  version: 1;
  sessionId: string;
  cursor: string;
  executionId?: string;
  turnId?: string;
  payload:
    | { type: "activity"; activity: ConversationActivity }
    | { type: "execution"; execution: ConversationExecution }
    | { type: "command"; receipt: ConversationReceipt };
}

export interface ConversationSnapshot extends CodingHistoryPage {
  version: 1;
  sessionId: string;
  cursor: string;
  execution?: ConversationExecution;
}

export interface ConversationEventPage {
  cursor: string;
  reset: boolean;
  events: ConversationEvent[];
}

export function isConversationCursor(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-f0-9-]{36}:[0-9]{1,15}$/u.test(value)
  );
}

export function isExecutionActive(
  execution: ConversationExecution | undefined,
): boolean {
  return (
    execution !== undefined &&
    ["preparing", "running", "stopping"].includes(execution.status)
  );
}
