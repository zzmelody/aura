import { isCodingSteerRequestId } from "@aura/protocol";
import { MessageError } from "@aura/i18n/runtime";
import { readErrorDetails } from "@aura/protocol/errors";
import { conversationMessage as message } from "../../conversation-messages.ts";
import type {
  CodingSubagent,
  CodingCapabilities,
  CodingCompactionResult,
} from "@aura/protocol/types";
import type {
  ChatModelSelection,
  CodingPermission,
  CodingCollaboration,
  CodingCollaborationAction,
  CodingRunIntent,
  CodingSteerModelConfig,
  ChatMessage,
  CodingActivity,
  CodingConversationInfo,
  CodingFileDiff,
  CodingHistoryTurn,
  CodingTurnUsage,
  CodingProjectInfo,
  CodingSkillInfo,
  CodingQuestionAnswer,
  CodingQuestionItem,
  AutomationHistory,
  AutomationTask,
  AutomationTaskInput,
  FlowMode,
  WorkspaceTerminalInfo,
  PersonalAssistantInfo,
} from "@aura/protocol/types";
import { WorkflowApiError } from "../../workflowSessions.ts";
import { startupFetch } from "../../startup-fetch.ts";
import { apiErrorText } from "../../api-error-messages.ts";

const base = (endpoint: string) => `${endpoint.replace(/\/$/, "")}/coding`;

export const listTerminals = (
  endpoint: string,
  projectId: string,
  signal?: AbortSignal,
) =>
  codingApi<WorkspaceTerminalInfo[]>(
    endpoint,
    `/terminals?projectId=${encodeURIComponent(projectId)}`,
    "GET",
    undefined,
    signal,
  );
export const openTerminal = (endpoint: string, projectId: string) =>
  codingApi<WorkspaceTerminalInfo>(endpoint, "/terminals", "POST", {
    projectId,
  });
export const writeTerminal = (endpoint: string, id: string, data: string) =>
  codingApi(endpoint, `/terminals/${encodeURIComponent(id)}/write`, "POST", {
    data,
  });
export const resizeTerminal = (
  endpoint: string,
  id: string,
  cols: number,
  rows: number,
) =>
  codingApi(endpoint, `/terminals/${encodeURIComponent(id)}/resize`, "POST", {
    cols,
    rows,
  });
export const closeTerminal = (endpoint: string, id: string, force = false) =>
  codingApi(
    endpoint,
    `/terminals/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
    "DELETE",
  );
export const terminalEventsUrl = (
  endpoint: string,
  id: string,
  cursor: number,
) =>
  `${base(endpoint)}/terminals/${encodeURIComponent(id)}/events?cursor=${cursor}`;

async function codingApi<T>(
  endpoint: string,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await (path === "/projects" && method === "GET"
    ? startupFetch(`${base(endpoint)}${path}`, signal)
    : fetch(`${base(endpoint)}${path}`, {
        method,
        signal,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
      }));
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkflowApiError(
      apiErrorText(
        value,
        message("codingServiceUnavailable", { status: response.status }),
      ),
      response.status,
    );
  return value as T;
}

export const listProjects = (endpoint: string, signal?: AbortSignal) =>
  codingApi<CodingProjectInfo[]>(
    endpoint,
    "/projects",
    "GET",
    undefined,
    signal,
  );

export const personalAssistant = (
  endpoint: string,
  create = false,
  signal?: AbortSignal,
) =>
  codingApi<PersonalAssistantInfo | null>(
    endpoint,
    "/assistant",
    create ? "POST" : "GET",
    undefined,
    signal,
  );

export const listSkills = (
  endpoint: string,
  projectId: string,
  signal?: AbortSignal,
) =>
  codingApi<CodingSkillInfo[]>(
    endpoint,
    `/projects/${encodeURIComponent(projectId)}/skills`,
    "GET",
    undefined,
    signal,
  );

export const createProject = (
  endpoint: string,
  directory: string,
  title?: string,
  signal?: AbortSignal,
) =>
  codingApi<CodingProjectInfo>(
    endpoint,
    "/projects",
    "POST",
    { directory, ...(title ? { title } : {}) },
    signal,
  );

export const renameProject = (
  endpoint: string,
  id: string,
  title: string,
  signal?: AbortSignal,
) =>
  codingApi<CodingProjectInfo>(
    endpoint,
    `/projects/${encodeURIComponent(id)}/rename`,
    "POST",
    { title },
    signal,
  );

/** Points a project at another directory; the project id changes with it. */
export const relocateProject = (
  endpoint: string,
  id: string,
  directory: string,
  signal?: AbortSignal,
) =>
  codingApi<CodingProjectInfo>(
    endpoint,
    `/projects/${encodeURIComponent(id)}/directory`,
    "POST",
    { directory },
    signal,
  );

export const removeProject = (endpoint: string, id: string) =>
  codingApi<{ removed: boolean }>(
    endpoint,
    `/projects/${encodeURIComponent(id)}`,
    "DELETE",
  );

export const listConversations = (
  endpoint: string,
  projectId: string,
  signal?: AbortSignal,
  includeStatus = true,
) =>
  codingApi<CodingConversationInfo[]>(
    endpoint,
    `/projects/${encodeURIComponent(projectId)}/conversations${includeStatus ? "" : "?status=metadata"}`,
    "GET",
    undefined,
    signal,
  );

/** Reply text or one activity entry from a streamed coding turn. */
type CodingTurnChunk = { type: "delta"; text: string } | CodingActivity;
export type CodingChunk =
  CodingTurnChunk | { type: "collaboration"; state: CodingCollaboration };

/**
 * Streams one coding turn. The runtime sends NDJSON: text deltas, activity
 * entries, then a single `done` or `error`. A stream that ends without `done`
 * was cut off, so it is reported rather than treated as a finished turn.
 */
/** A cached workspace is only a hint; validate it before a queued turn can run. */
export async function prepareCodingTurn(
  endpoint: string,
  projectId: string,
  signal: AbortSignal,
) {
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  let projects: CodingProjectInfo[];
  try {
    projects = await listProjects(endpoint, waiting);
  } catch (error) {
    signal.throwIfAborted();
    if (waiting.aborted)
      throw new MessageError(message("admissionTimedOut"), {
        cause: error,
      });
    throw error;
  }
  signal.throwIfAborted();
  const project = projects.find((item) => item.id === projectId);
  if (!project || project.status === "missing-dir")
    throw new MessageError(message("workspaceUnavailable"));
}

export async function* codingTurn(
  endpoint: string,
  turn: {
    sessionId: string;
    projectId?: string;
    prompt: string;
    /** Uploaded chat image asset IDs. */
    images?: string[];
    /** Set on a side chat: the conversation it branches from. */
    forkFrom?: string;
    branchFrom?: string;
    branchAt?: number;
    history?: ChatMessage[];
    context?: string;
    mode: FlowMode;
    modelConfig?: ChatModelSelection;
    /** Applied before the turn starts; omitted keeps the saved preset. */
    permission?: CodingPermission;
    intent?: CodingRunIntent;
  },
  signal: AbortSignal,
): AsyncGenerator<CodingChunk> {
  const response = await fetch(`${base(endpoint)}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(turn),
    signal,
  });
  if (!response.ok || !response.body)
    throw new MessageError(
      apiErrorText(
        { code: response.headers.get("X-Aura-Error-Code") },
        (await response.text().catch(() => "")) ||
          message("codingConnectFailed", { status: response.status }),
      ),
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "collaboration") {
          const state = parseCollaboration(event.state);
          if (state) yield { type: "collaboration", state };
          continue;
        }
        const parsed = parseCodingEvent(event);
        if (parsed) yield parsed;
        else if (event.type === "error")
          throw new MessageError(
            apiErrorText(event, message("codingUnavailable")),
          );
        else if (event.type === "done") completed = true;
      }
    }
    if (!completed) throw new MessageError(message("codingStreamInterrupted"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Validates one untrusted turn event, live or replayed. Unknown or malformed
 * events yield nothing, so a newer runtime cannot break an older page.
 */
function parseCodingEvent(
  event: Record<string, unknown>,
): CodingTurnChunk | undefined {
  if (event.type === "usage") {
    const usage = codingUsage(event.usage);
    return usage ? { type: "usage", usage } : undefined;
  }
  if (event.type === "turn-boundary" && validCount(event.endSeq))
    return { type: "turn-boundary", endSeq: event.endSeq };
  if (
    event.type === "workflow" &&
    typeof event.runId === "string" &&
    typeof event.flowId === "string" &&
    typeof event.title === "string"
  )
    return {
      type: "workflow",
      runId: event.runId,
      flowId: event.flowId,
      title: event.title,
      inputPreview:
        typeof event.inputPreview === "string" ? event.inputPreview : "",
    };
  if (
    event.type === "notice" &&
    typeof event.id === "string" &&
    typeof event.text === "string"
  )
    return {
      type: "notice",
      id: event.id,
      text: event.text,
      at: typeof event.at === "number" ? event.at : Date.now(),
    };
  if (
    event.type === "web" &&
    typeof event.callId === "string" &&
    Array.isArray(event.sources)
  )
    return {
      type: "web",
      callId: event.callId,
      truncated: event.truncated === true,
      at: typeof event.at === "number" ? event.at : Date.now(),
      ...(typeof event.statusCode === "number"
        ? { statusCode: event.statusCode }
        : {}),
      sources: event.sources.flatMap((source: unknown) => {
        if (!source || typeof source !== "object") return [];
        const item = source as Record<string, unknown>;
        if (typeof item.url !== "string" || typeof item.title !== "string")
          return [];
        try {
          const url = new URL(item.url);
          return ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password
            ? [{ url: url.href, title: item.title }]
            : [];
        } catch {
          return [];
        }
      }),
    };
  if (event.type === "delta" && typeof event.text === "string")
    return { type: "delta", text: event.text };
  const at = typeof event.at === "number" ? event.at : Date.now();
  if (
    event.type === "model" &&
    (event.phase === "start" || event.phase === "end")
  )
    return { type: "model", phase: event.phase, at };
  if (
    event.type === "tool" &&
    typeof event.callId === "string" &&
    (event.phase === "start" || event.phase === "end")
  )
    return event.phase === "start"
      ? {
          type: "tool",
          phase: "start",
          callId: event.callId,
          name: String(event.name ?? "tool"),
          ...(typeof event.detail === "string" ? { detail: event.detail } : {}),
          at,
        }
      : {
          type: "tool",
          phase: "end",
          callId: event.callId,
          ok: event.ok !== false,
          at,
          ...(Array.isArray(event.diffs)
            ? { diffs: fileDiffs(event.diffs) }
            : {}),
        };
  if (
    event.type === "progress" &&
    typeof event.done === "number" &&
    typeof event.total === "number"
  )
    return { type: "progress", done: event.done, total: event.total };
  if (event.type === "deliverable" && typeof event.path === "string")
    return { type: "deliverable", path: event.path };
  if (event.type === "steer" && typeof event.text === "string" && event.text)
    return {
      type: "steer",
      text: event.text,
      at,
      ...(isCodingSteerRequestId(event.requestId)
        ? { requestId: event.requestId }
        : {}),
      ...(event.delivery === "queued" || event.delivery === "canceled"
        ? { delivery: event.delivery }
        : {}),
    };
  if (
    event.type === "question" &&
    typeof event.questionId === "string" &&
    Array.isArray(event.questions)
  )
    return {
      type: "question",
      questionId: event.questionId,
      questions: questionItems(event.questions),
    };
  if (
    event.type === "answered" &&
    typeof event.questionId === "string" &&
    Array.isArray(event.answers)
  )
    return {
      type: "answered",
      questionId: event.questionId,
      answers: answerItems(event.answers),
    };
  return undefined;
}

function answerItems(value: unknown[]): CodingQuestionAnswer[] {
  return value.flatMap((raw) => {
    const item = raw as {
      id?: unknown;
      selected?: unknown;
      custom?: unknown;
    } | null;
    if (typeof item?.id !== "string") return [];
    return [
      {
        id: item.id,
        selected: Array.isArray(item.selected)
          ? item.selected.filter(
              (label): label is string => typeof label === "string",
            )
          : [],
        ...(typeof item.custom === "string" ? { custom: item.custom } : {}),
      },
    ];
  });
}

/** Keeps only well-formed hunks from an untrusted stream event. */
function fileDiffs(value: unknown[]): CodingFileDiff[] {
  return value.flatMap((item) => {
    const diff = item as Partial<Record<keyof CodingFileDiff, unknown>> | null;
    if (
      typeof diff?.path !== "string" ||
      typeof diff.newText !== "string" ||
      (diff.oldText !== null && typeof diff.oldText !== "string")
    )
      return [];
    return [
      {
        path: diff.path,
        oldText: typeof diff.oldText === "string" ? diff.oldText : null,
        newText: diff.newText,
      },
    ];
  });
}

/** Discards a side chat; the main conversation is not affected. */
export const closeSideChat = (endpoint: string, sessionId: string) =>
  codingApi<{ closed: boolean }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/side`,
    "DELETE",
  );

export const saveConversationModel = (
  endpoint: string,
  sessionId: string,
  mode: FlowMode,
  selection: ChatModelSelection,
) =>
  codingApi<{ updated: true }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/model`,
    "POST",
    { mode, selection },
  );

export const saveConversationPermission = (
  endpoint: string,
  sessionId: string,
  permission: CodingPermission,
) =>
  codingApi<{ updated: true }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/permission`,
    "POST",
    { permission },
  );

export async function changeCodingCollaboration(
  endpoint: string,
  sessionId: string,
  action: CodingCollaborationAction,
): Promise<CodingCollaboration> {
  const state = parseCollaboration(
    await codingApi<unknown>(
      endpoint,
      `/sessions/${encodeURIComponent(sessionId)}/collaboration`,
      "POST",
      { action },
    ),
  );
  if (!state) throw new MessageError(message("collaborationReadFailed"));
  return state;
}

export async function readCodingCollaboration(
  endpoint: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<CodingCollaboration | undefined> {
  return parseCollaboration(
    await codingApi<unknown>(
      endpoint,
      `/sessions/${encodeURIComponent(sessionId)}/collaboration`,
      "GET",
      undefined,
      signal,
    ),
  );
}

/** Sends the user's answer to a question the agent is waiting on. */
export const answerQuestion = (
  endpoint: string,
  sessionId: string,
  questionId: string,
  answers: CodingQuestionAnswer[],
) =>
  codingApi<{ accepted: boolean }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/answer`,
    "POST",
    { questionId, answers },
  );

/** Keeps only well-formed questions from an untrusted stream event. */
function questionItems(value: unknown[]): CodingQuestionItem[] {
  return value.flatMap((raw) => {
    const item = raw as Partial<
      Record<keyof CodingQuestionItem, unknown>
    > | null;
    if (typeof item?.id !== "string" || typeof item.question !== "string")
      return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          const value = option as { label?: unknown; description?: unknown };
          return typeof value?.label === "string"
            ? [
                {
                  label: value.label,
                  ...(typeof value.description === "string"
                    ? { description: value.description }
                    : {}),
                },
              ]
            : [];
        })
      : [];
    return [
      {
        id: item.id,
        question: item.question,
        ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
        ...(typeof item.header === "string" ? { header: item.header } : {}),
        ...(options.length ? { options } : {}),
        ...(item.multiSelect === true ? { multiSelect: true } : {}),
        ...(item.kind === "approval" ? { kind: "approval" as const } : {}),
        ...approvalFacts(item.approval),
        ...planIntent(item.intent, options),
      },
    ];
  });
}

/** Keeps the well-formed string fields of an approval's structured facts. */
function approvalFacts(value: unknown): Pick<CodingQuestionItem, "approval"> {
  const facts = value as Record<string, unknown> | null | undefined;
  if (typeof facts?.toolName !== "string") return {};
  const text = (key: string) =>
    typeof facts[key] === "string" ? { [key]: facts[key] as string } : {};
  const display =
    typeof facts.displayReason === "object" && facts.displayReason !== null
      ? Object.fromEntries(
          Object.entries(facts.displayReason).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return {
    approval: {
      toolName: facts.toolName,
      ...text("escalation"),
      ...text("reason"),
      ...(Object.keys(display).length ? { displayReason: display } : {}),
    },
  };
}

/** Stops a conversation's running turn on the backend. */
export const stopCodingTurn = (endpoint: string, sessionId: string) =>
  codingApi<{ stopped: boolean }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/stop`,
    "POST",
  );

/**
 * Sends guidance into the turn already running. It joins that turn, so what
 * the model does with it arrives on the turn's own stream rather than here;
 * `steered` is false when the turn could not accept the guidance.
 */
export const steerCodingTurn = (
  endpoint: string,
  sessionId: string,
  prompt: string,
  images?: string[],
  modelConfig?: CodingSteerModelConfig,
  signal?: AbortSignal,
  requestId?: string,
) =>
  codingApi<{ steered: boolean }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/steer`,
    "POST",
    {
      prompt,
      ...(images?.length ? { images } : {}),
      ...(modelConfig ? { modelConfig } : {}),
      ...(requestId ? { requestId } : {}),
    },
    signal,
  );

/** Saves a fork as its own conversation, inheriting through one completed turn. */
export const forkConversation = (
  endpoint: string,
  sessionId: string,
  endSeq: number,
) =>
  codingApi<{ conversation: CodingConversationInfo }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/fork`,
    "POST",
    { endSeq },
  );

export const openSideChat = (endpoint: string, parentId: string) =>
  codingApi<{ sessionId: string }>(
    endpoint,
    `/sessions/${encodeURIComponent(parentId)}/side`,
    "POST",
  );

export const archiveConversation = (
  endpoint: string,
  sessionId: string,
  archived: boolean,
) =>
  codingApi<{ updated: boolean }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/archive`,
    "POST",
    { archived },
  );

export const closeConversation = (endpoint: string, sessionId: string) =>
  codingApi<{ updated: boolean }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}`,
    "DELETE",
  );

/** A stored conversation, rebuilt from its session log by the runtime. */
export async function conversationHistory(
  endpoint: string,
  sessionId: string,
  signal?: AbortSignal,
  page: { beforeSeq?: number; throughSeq?: number } = {},
): Promise<{
  turns: CodingHistoryTurn[];
  running: boolean;
  collaboration?: CodingCollaboration;
  hasMore: boolean;
  beforeSeq?: number;
  throughSeq?: number;
}> {
  const query = new URLSearchParams({ page: "1" });
  if (page.beforeSeq !== undefined && page.throughSeq !== undefined) {
    query.set("beforeSeq", String(page.beforeSeq));
    query.set("throughSeq", String(page.throughSeq));
  }
  const timeout = AbortSignal.timeout(8_000);
  let value: unknown;
  try {
    value = await codingApi<unknown>(
      endpoint,
      `/sessions/${encodeURIComponent(sessionId)}/history?${query}`,
      "GET",
      undefined,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted)
      throw new MessageError(message("historyReadTimeout"), { cause: error });
    throw error;
  }
  return parseConversationHistory(value);
}

export function parseConversationHistory(value: unknown) {
  const body = value as {
    turns?: unknown;
    running?: unknown;
    collaboration?: unknown;
    hasMore?: unknown;
    beforeSeq?: unknown;
    throughSeq?: unknown;
  } | null;
  if (typeof body?.running !== "boolean")
    throw new MessageError(message("historyStateUnknown"));
  const turns = Array.isArray(body?.turns) ? body.turns : [];
  return {
    running: body.running,
    collaboration: parseCollaboration(body.collaboration),
    hasMore: body?.hasMore === true,
    beforeSeq: typeof body?.beforeSeq === "number" ? body.beforeSeq : undefined,
    throughSeq:
      typeof body?.throughSeq === "number" ? body.throughSeq : undefined,
    turns: turns.flatMap((raw) => {
      const turn = raw as Partial<Record<keyof CodingHistoryTurn, unknown>>;
      if (
        typeof turn?.prompt !== "string" ||
        typeof turn.startedAt !== "number" ||
        !Array.isArray(turn.events)
      )
        return [];
      const status = ["running", "complete", "stopped", "error"].includes(
        String(turn.status),
      )
        ? (turn.status as CodingHistoryTurn["status"])
        : "stopped";
      const errorDetails = readErrorDetails(turn.errorDetails);
      return [
        {
          ...(typeof turn.turnId === "string" ? { turnId: turn.turnId } : {}),
          prompt: turn.prompt,
          startedAt: turn.startedAt,
          status,
          ...(typeof turn.endedAt === "number"
            ? { endedAt: turn.endedAt }
            : {}),
          ...(validCount(turn.endSeq) ? { endSeq: turn.endSeq } : {}),
          ...(typeof turn.error === "string" ? { error: turn.error } : {}),
          ...(errorDetails ? { errorDetails } : {}),
          events: turn.events.flatMap((event) => {
            const parsed = parseCodingEvent(event as Record<string, unknown>);
            return parsed ? [parsed] : [];
          }),
        },
      ];
    }),
  };
}

function parseCollaboration(value: unknown): CodingCollaboration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { planning, goal } = value as { planning?: unknown; goal?: unknown };
  if (typeof planning !== "boolean") return undefined;
  if (typeof goal !== "object" || goal === null) return { planning };
  const { objective, phase, armed, roundsStarted, maxGoalRounds } =
    goal as Record<string, unknown>;
  if (
    typeof objective !== "string" ||
    (phase !== "active" &&
      phase !== "paused" &&
      phase !== "blocked" &&
      phase !== "complete") ||
    typeof armed !== "boolean" ||
    !validCount(roundsStarted) ||
    !validCount(maxGoalRounds) ||
    maxGoalRounds === 0
  )
    return { planning };
  return {
    planning,
    goal: { objective, phase, armed, roundsStarted, maxGoalRounds },
  };
}

/** The agent can stop accepting guidance before the host finishes the turn. */
export async function waitForCodingTurnEnd(
  endpoint: string,
  sessionId: string,
  signal: AbortSignal,
  onRunningTurn?: (turn: CodingHistoryTurn) => void,
  onCollaboration?: (state: CodingCollaboration) => void,
): Promise<CodingHistoryTurn | undefined> {
  while (true) {
    signal.throwIfAborted();
    const history = await conversationHistory(endpoint, sessionId, signal);
    signal.throwIfAborted();
    if (history.collaboration) onCollaboration?.(history.collaboration);
    const latest = history.turns.at(-1);
    if (!history.running) return latest;
    if (latest?.status === "running") onRunningTurn?.(latest);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, 2_000);
      const cancel = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function codingUsage(value: unknown): CodingTurnUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const {
    totalTokens,
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  } = value as Record<string, unknown>;
  if (
    !validCount(totalTokens) ||
    !validCount(uncachedInputTokens) ||
    !validCount(outputTokens)
  )
    return undefined;
  return {
    totalTokens,
    uncachedInputTokens,
    outputTokens,
    ...(validCount(cacheReadTokens) ? { cacheReadTokens } : {}),
    ...(validCount(cacheWriteTokens) ? { cacheWriteTokens } : {}),
    ...(validCount(reasoningTokens) ? { reasoningTokens } : {}),
  };
}

/** Keeps a plan-review intent only when it names one of the offered options. */
function planIntent(
  intent: unknown,
  options: ReadonlyArray<{ label: string }>,
): Pick<CodingQuestionItem, "intent"> {
  const value = intent as { kind?: unknown; approve?: unknown } | null;
  return value?.kind === "plan-review" &&
    typeof value.approve === "string" &&
    options.some((option) => option.label === value.approve)
    ? { intent: { kind: "plan-review", approve: value.approve } }
    : {};
}

/** Automation tasks: DSH Schedule reminders on coding conversations. */
export const listAutomation = (endpoint: string, signal?: AbortSignal) =>
  codingApi<AutomationTask[]>(
    endpoint,
    "/automation",
    "GET",
    undefined,
    signal,
  );

export const createAutomation = (
  endpoint: string,
  input: AutomationTaskInput,
) => codingApi<AutomationTask>(endpoint, "/automation", "POST", input);

const automationPath = (sessionId: string, id: string) =>
  `/automation/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}`;

export const updateAutomation = (
  endpoint: string,
  id: string,
  input: AutomationTaskInput,
) =>
  codingApi<AutomationTask>(
    endpoint,
    automationPath(input.sessionId, id),
    "POST",
    input,
  );

export const deleteAutomation = (
  endpoint: string,
  sessionId: string,
  id: string,
) =>
  codingApi<{ deleted: boolean }>(
    endpoint,
    `${automationPath(sessionId, id)}/delete`,
    "POST",
  );

export const automationHistory = (
  endpoint: string,
  sessionId: string,
  id: string,
  signal?: AbortSignal,
) =>
  codingApi<AutomationHistory>(
    endpoint,
    `${automationPath(sessionId, id)}/history`,
    "GET",
    undefined,
    signal,
  );

export const readCodingCapabilities = (endpoint: string) =>
  codingApi<CodingCapabilities>(endpoint, "/capabilities");
export const saveCodingCapabilities = (endpoint: string, source: unknown) =>
  codingApi<CodingCapabilities>(endpoint, "/capabilities", "POST", source);
export const compactCoding = (endpoint: string, sessionId: string) =>
  codingApi<CodingCompactionResult>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/compact`,
    "POST",
  );

export const readCodingSubagents = (
  endpoint: string,
  sessionId: string,
  signal?: AbortSignal,
) =>
  codingApi<CodingSubagent[]>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/agents`,
    "GET",
    undefined,
    signal,
  );
export const stopCodingSubagent = (
  endpoint: string,
  sessionId: string,
  childId: string,
) =>
  codingApi<{ accepted: true }>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(childId)}/stop`,
    "POST",
  );
