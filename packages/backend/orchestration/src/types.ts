import type {
  JsonValue,
  FlowMode,
  ChatMessage,
  ChatWorkflowStart,
} from "@aura/protocol/types";
import type { FlowImageReference } from "./flow-api.ts";
import type {
  FlowCatalog,
  FlowCatalogEntry,
  FlowHistory,
  FlowRun,
  FlowAgentStep,
  FlowAgentConfig,
  AuraPluginIdentity,
  AuraPluginStatus,
} from "@aura/protocol/types";
import type { LoadedFlow } from "./registry.ts";
import type { ActionRegistry, LoadedAction } from "./action-registry.ts";
import type { ActionRuntime } from "./actions.ts";

export interface HostOptions {
  root: string;
  dshHome: string;
  modelURL: string;
  codexModel?: string;
  flowRoot?: string;
  actionRoot?: string;
  flowRoots?: ContributionRoot[];
  actionRoots?: ContributionRoot[];
  capabilityRoots?: CapabilityRoot[];
  plugins?: AuraPluginStatus[];
  tripoCredentialPath?: string;
  tripoRegion?: "global" | "china";
}

export interface ContributionRoot {
  root: string;
  namespace?: string;
  plugin?: AuraPluginIdentity;
  /** Trusted local package root, never projected into public catalog DTOs. */
  pluginRoot?: string;
  capabilities?: string[];
}

/** A plugin's capability provider directory and its opaque plugins.json settings. */
export interface CapabilityRoot extends ContributionRoot {
  settings?: JsonValue;
}

export interface ContributionConfiguration {
  flowRoots: ContributionRoot[];
  actionRoots: ContributionRoot[];
  capabilityRoots: CapabilityRoot[];
  plugins: AuraPluginStatus[];
}

export type FlowRpcResult<T> =
  { ok: true; data: T } | { ok: false; status: number; message: string };

export interface Table<T> {
  get(id: string): T | undefined;
  entries(): IterableIterator<[string, T]>;
  put(id: string, value: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  update(id: string, change: (current: T) => T): Promise<T>;
}

export interface FlowDomain {
  table(name: "runs"): Table<FlowRun>;
}

export interface SessionPort {
  /** Validate exact provider/model controls without starting a session or a model request. */
  validateConfig?(config: FlowAgentConfig): Promise<void>;
  execute(
    step: FlowAgentStep & {
      input: string;
      images?: FlowImageReference[];
      mode: FlowMode;
      timeoutMs: number;
      signal: AbortSignal;
      runId: string;
      actionDefinitions: readonly LoadedAction[];
    },
  ): Promise<string>;
  history(step: FlowAgentStep, beforeSeq?: number): Promise<FlowHistory>;
  reconcile?(step: FlowAgentStep): Promise<{
    output?: string;
    actionStarted: boolean;
  }>;
}

export interface EngineOptions {
  resolveAgentDefaults?(
    mode: FlowMode | "configured",
  ): Promise<FlowAgentConfig>;
  domain: FlowDomain;
  sessions: SessionPort;
  registry: {
    get(id: string): LoadedFlow;
    catalog(): FlowCatalogEntry[];
  };
  refreshFlows(): Promise<void>;
  presets(): Promise<FlowCatalog["presets"]>;
  plugins?: AuraPluginStatus[];
  /** Called once per root Run after it reaches a terminal status. */
  onRootSettled?(run: FlowRun): Promise<void>;
  actions?: {
    registry: Pick<ActionRegistry, "snapshot" | "catalog">;
    runtime: Pick<ActionRuntime, "execute">;
    cwd: string;
  };
}

/** One chat request handled by the long-lived DSH host. */
export interface ChatTurn {
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
  /** Aura-owned id of the coding conversation, stable across turns. */
  sessionId: string;
  /** Project the conversation belongs to; the backend resolves its directory. */
  projectId: string;
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
  mode: FlowMode;
  model?: string;
  reasoningEffort?: string;
  /** Resolved server-side for gateway modes; never accepted from a client. */
  defaults?: FlowAgentConfig;
}

/**
 * Streamed coding output. Beyond reply text it carries what the agent is
 * doing, so the transcript can show tool activity, task progress and files
 * the agent declared, rather than only its final answer.
 */
export type CodingStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "tool";
      phase: "start";
      callId: string;
      name: string;
      /** The file, command or pattern the call touches, when it names one. */
      detail?: string;
    }
  | {
      type: "tool";
      phase: "end";
      callId: string;
      ok: boolean;
      /** Applied hunks of a write or edit, for the file-change card. */
      diffs?: CodingFileDiff[];
    }
  | { type: "progress"; done: number; total: number }
  | { type: "deliverable"; path: string }
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
}

/** One request in a replayed coding conversation and everything it produced. */
export interface CodingHistoryTurn {
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "complete" | "stopped" | "error";
  error?: string;
  /** The same events a live turn streams, in log order. */
  events: CodingStreamEvent[];
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

/** A project directory a coding conversation can run in. */
export interface CodingProject {
  id: string;
  /** Canonical absolute path; the workspace registry's uniqueness canon. */
  directory: string;
  title: string;
}

/** A coding conversation as listed for one project. */
export interface CodingConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
