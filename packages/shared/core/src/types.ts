import type {
  ChatMessage,
  ChatModelSelection,
  FlowPhase,
  FlowMode,
  JsonValue,
} from "@aura/protocol/types";

/** Theme preference persisted independently of the system theme. */
export type ThemeMode = "dark" | "light" | "system";
/** A local message, including transient generation status. */
export type Message = Omit<ChatMessage, "images"> & {
  id: string;
  status: "streaming" | "complete" | "stopped" | "error";
  workflowRunId?: string;
  workflowPhase?: FlowPhase;
  /** Run started from an ordinary conversation rather than a bound session. */
  workflow?: WorkflowRef;
  /** Images the user attached; only references, never image bytes. */
  images?: ChatImage[];
};
export type ChatImage = {
  assetId: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width?: number;
  height?: number;
  name?: string;
};
export type WorkflowRef = { id: string; title: string; endpoint: string };
export type WorkflowBinding = {
  id: string;
  title: string;
  endpoint: string;
  inputSchema?: JsonValue;
  pending?: { requestId: string; input: JsonValue; mode: FlowMode };
};
/** A locally stored conversation. */
export type Session = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
  /** Archive only changes the local list; execution and history remain intact. */
  archivedAt?: number;
  /** Ordinary-chat choices, isolated by mode and never applied to Flow Agents. */
  modelConfig?: Partial<Record<FlowMode, ChatModelSelection>>;
  workflow?: WorkflowBinding;
  /** Unconfirmed run submitted from an ordinary conversation. */
  pendingWorkflow?: WorkflowBinding & {
    pending: NonNullable<WorkflowBinding["pending"]>;
  };
};
/** Version-one client storage; contains no model credentials. */
export type Workspace = {
  version: number;
  theme: ThemeMode;
  reduceMotion: boolean;
  endpoint: string;
  provider: "offline" | "dsh" | "codex";
  sessions: Session[];
  sidebarWidth?: number;
  hiddenWorkflowRuns?: string[];
};
