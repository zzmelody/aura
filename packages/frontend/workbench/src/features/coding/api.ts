import type {
  ChatModelSelection,
  CodingActivity,
  CodingConversationInfo,
  CodingFileDiff,
  CodingHistoryTurn,
  CodingProjectInfo,
  CodingQuestionAnswer,
  CodingQuestionItem,
  FlowMode,
} from "@aura/protocol/types";
import { WorkflowApiError } from "../../workflowSessions";

const base = (endpoint: string) => `${endpoint.replace(/\/$/, "")}/coding`;

async function codingApi<T>(
  endpoint: string,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${base(endpoint)}${path}`, {
    method,
    signal,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkflowApiError(
      value?.message || `编码服务暂不可用（${response.status}）。`,
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
) =>
  codingApi<CodingConversationInfo[]>(
    endpoint,
    `/projects/${encodeURIComponent(projectId)}/conversations`,
    "GET",
    undefined,
    signal,
  );

/** Reply text or one activity entry from a streamed coding turn. */
export type CodingChunk = { type: "delta"; text: string } | CodingActivity;

/**
 * Streams one coding turn. The runtime sends NDJSON: text deltas, activity
 * entries, then a single `done` or `error`. A stream that ends without `done`
 * was cut off, so it is reported rather than treated as a finished turn.
 */
export async function* codingTurn(
  endpoint: string,
  turn: {
    sessionId: string;
    projectId: string;
    prompt: string;
    mode: FlowMode;
    modelConfig?: ChatModelSelection;
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
    throw new Error(
      (await response.text().catch(() => "")) ||
        `编码服务连接失败（${response.status}）。`,
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
        const parsed = parseCodingEvent(event);
        if (parsed) yield parsed;
        else if (event.type === "error")
          throw new Error(
            typeof event.message === "string"
              ? event.message
              : "编码服务暂时不可用。",
          );
        else if (event.type === "done") completed = true;
      }
    }
    if (!completed) throw new Error("连接已中断，可以重新发送这条消息。");
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
): CodingChunk | undefined {
  if (event.type === "delta" && typeof event.text === "string")
    return { type: "delta", text: event.text };
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
        }
      : {
          type: "tool",
          phase: "end",
          callId: event.callId,
          ok: event.ok !== false,
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
        ...planIntent(item.intent, options),
      },
    ];
  });
}

/** A stored conversation, rebuilt from its session log by the runtime. */
export async function conversationHistory(
  endpoint: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ turns: CodingHistoryTurn[]; running: boolean }> {
  const value = await codingApi<unknown>(
    endpoint,
    `/sessions/${encodeURIComponent(sessionId)}/history`,
    "GET",
    undefined,
    signal,
  );
  const body = value as { turns?: unknown; running?: unknown } | null;
  const turns = Array.isArray(body?.turns) ? body.turns : [];
  return {
    running: body?.running === true,
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
      return [
        {
          prompt: turn.prompt,
          startedAt: turn.startedAt,
          status,
          ...(typeof turn.endedAt === "number"
            ? { endedAt: turn.endedAt }
            : {}),
          ...(typeof turn.error === "string" ? { error: turn.error } : {}),
          events: turn.events.flatMap((event) => {
            const parsed = parseCodingEvent(event as Record<string, unknown>);
            return parsed ? [parsed] : [];
          }),
        },
      ];
    }),
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
