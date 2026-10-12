import type {
  ChatModelSelection,
  CodingActivity,
  CodingConversationInfo,
  CodingFileDiff,
  CodingProjectInfo,
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
) =>
  codingApi<CodingProjectInfo>(endpoint, "/projects", "POST", {
    directory,
    ...(title ? { title } : {}),
  });

export const renameProject = (endpoint: string, id: string, title: string) =>
  codingApi<CodingProjectInfo>(
    endpoint,
    `/projects/${encodeURIComponent(id)}/rename`,
    "POST",
    { title },
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
export type CodingChunk =
  { type: "delta"; text: string } | ({ kind: "activity" } & CodingActivity);

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
        if (event.type === "delta" && typeof event.text === "string")
          yield { type: "delta", text: event.text };
        else if (
          event.type === "tool" &&
          typeof event.callId === "string" &&
          (event.phase === "start" || event.phase === "end")
        )
          yield event.phase === "start"
            ? {
                kind: "activity",
                type: "tool",
                phase: "start",
                callId: event.callId,
                name: String(event.name ?? "tool"),
                ...(typeof event.detail === "string"
                  ? { detail: event.detail }
                  : {}),
              }
            : {
                kind: "activity",
                type: "tool",
                phase: "end",
                callId: event.callId,
                ok: event.ok !== false,
                ...(Array.isArray(event.diffs)
                  ? { diffs: fileDiffs(event.diffs) }
                  : {}),
              };
        else if (
          event.type === "progress" &&
          typeof event.done === "number" &&
          typeof event.total === "number"
        )
          yield {
            kind: "activity",
            type: "progress",
            done: event.done,
            total: event.total,
          };
        else if (event.type === "deliverable" && typeof event.path === "string")
          yield { kind: "activity", type: "deliverable", path: event.path };
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
