import type { Message, Session, Workspace } from "@aura/core/types";
import type {
  FlowPhase,
  FlowStepPhase,
  FlowRun,
  FlowRunSummary,
} from "@aura/protocol/types";

export const workflowPhaseLabels: Record<FlowPhase | FlowStepPhase, string> = {
  queued: "等待执行",
  running: "正在运行",
  completed: "已完成",
  failed: "运行失败",
  cancelled: "已取消",
  interrupted: "已中断",
  pausing: "正在暂停",
  paused: "已暂停",
  waiting_input: "等待输入",
  needs_attention: "需要处理",
  unknown: "结果待确认",
};
export const workflowRunKey = (endpoint: string, id: string) =>
  `${endpoint}/${id}`;
export const isWorkflowActive = (phase?: FlowPhase) =>
  phase === "queued" || phase === "running" || phase === "pausing";
export const isWorkflowOpen = (phase?: FlowPhase) =>
  isWorkflowActive(phase) ||
  phase === "paused" ||
  phase === "waiting_input" ||
  phase === "needs_attention";
const messageStatus = (phase: FlowPhase): Message["status"] =>
  isWorkflowActive(phase)
    ? "streaming"
    : phase === "failed"
      ? "error"
      : phase === "cancelled" || phase === "interrupted"
        ? "stopped"
        : "complete";

/** Service origin of a run message, whether the session is bound or ordinary. */
export const messageEndpoint = (session: Session, message: Message) =>
  message.workflow?.endpoint ?? session.workflow?.endpoint;
const holdsRun = (session: Session, endpoint: string, runId: string) =>
  session.messages.some(
    (message) =>
      message.workflowRunId === runId &&
      messageEndpoint(session, message) === endpoint,
  );

export function mergeWorkflowRuns(
  state: Workspace,
  runs: FlowRunSummary[],
  endpoint: string,
  importUnknown = true,
): Workspace {
  let sessions = state.sessions;
  const hidden = new Set(state.hiddenWorkflowRuns);
  for (const run of runs) {
    const found = sessions.find((session) =>
      holdsRun(session, endpoint, run.id),
    );
    if (!found) {
      if (!importUnknown || hidden.has(workflowRunKey(endpoint, run.id)))
        continue;
      sessions = [
        ...sessions,
        {
          id: `workflow:${workflowRunKey(endpoint, run.id)}`,
          title: run.title,
          updatedAt: run.createdAt,
          workflow: { id: run.flowId, title: run.title, endpoint },
          messages: [
            {
              id: `${run.id}:input`,
              role: "user",
              text: run.inputPreview,
              status: "complete",
            },
            {
              id: `${run.id}:output`,
              role: "assistant",
              text: workflowPhaseLabels[run.status],
              status: messageStatus(run.status),
              workflowRunId: run.id,
              workflowPhase: run.status,
            },
          ],
        },
      ];
    } else if (
      found.messages.some(
        (message) =>
          message.workflowRunId === run.id &&
          (message.workflowPhase !== run.status ||
            message.status !== messageStatus(run.status)),
      )
    ) {
      sessions = sessions.map((session) =>
        session === found
          ? {
              ...session,
              messages: session.messages.map((message) =>
                message.workflowRunId === run.id
                  ? {
                      ...message,
                      workflowPhase: run.status,
                      status: messageStatus(run.status),
                      text: workflowPhaseLabels[run.status],
                    }
                  : message,
              ),
            }
          : session,
      );
    }
  }
  return sessions === state.sessions
    ? state
    : {
        ...state,
        sessions: sessions
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 100),
      };
}

export function applyWorkflowRun(
  state: Workspace,
  endpoint: string,
  run: FlowRun,
): Workspace {
  const output = run.output;
  const report =
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    typeof output.report === "string"
      ? output.report
      : output === undefined
        ? undefined
        : JSON.stringify(output, null, 2);
  const text = (run.error || report || workflowPhaseLabels[run.status]).slice(
    0,
    24000,
  );
  const values =
    run.input && typeof run.input === "object" && !Array.isArray(run.input)
      ? Object.values(run.input)
      : [];
  const input = (
    values.length === 1 && typeof values[0] === "string"
      ? values[0]
      : JSON.stringify(run.input, null, 2)
  ).slice(0, 24000);
  let changed = false;
  const sessions = state.sessions.map((session) => {
    if (!holdsRun(session, endpoint, run.id)) return session;
    const messages = session.messages.map((message) => {
      if (
        message.role === "user" &&
        message.id === `${run.id}:input` &&
        message.text !== input
      ) {
        changed = true;
        return { ...message, text: input };
      }
      if (
        message.workflowRunId !== run.id ||
        (message.text === text &&
          message.workflowPhase === run.status &&
          message.status === messageStatus(run.status))
      )
        return message;
      changed = true;
      return {
        ...message,
        text,
        workflowPhase: run.status,
        status: messageStatus(run.status),
      };
    });
    return messages.some(
      (message, index) => message !== session.messages[index],
    )
      ? { ...session, messages }
      : session;
  });
  return changed ? { ...state, sessions } : state;
}

export class WorkflowApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Upload bytes once; Flow inputs and saved drafts contain only the asset ID. */
export async function uploadWorkflowImage(
  endpoint: string,
  file: File,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<string> {
  if (file.size < 1 || file.size > 32 * 1024 * 1024)
    throw new Error("图片必须小于 32 MiB。");
  const mimeType = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  }[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  const type = ["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ? file.type
    : mimeType;
  if (!type) throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  const response = await request(
    `${endpoint.replace(/\/$/, "")}/flows/assets/images`,
    {
      method: "POST",
      headers: { "Content-Type": type },
      body: file,
      signal,
    },
  );
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkflowApiError(
      value?.message || `图片上传失败（${response.status}）。`,
      response.status,
    );
  if (
    !value ||
    typeof value.assetId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.assetId)
  )
    throw new Error("图片上传没有返回有效的资产 ID。");
  return value.assetId;
}

export async function workflowApi<T>(
  endpoint: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/flows${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal,
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkflowApiError(
      value?.message || `工作流服务暂不可用（${response.status}）。`,
      response.status,
    );
  return value as T;
}

/**
 * Chat context for an ordinary conversation: a run's input record is dropped,
 * a settled run becomes one short assistant summary, and open runs are left
 * out until they finish.
 */
export function chatHistory(messages: Message[]): Message[] {
  const inputs = new Set(
    messages.flatMap((message) =>
      message.workflowRunId ? [`${message.workflowRunId}:input`] : [],
    ),
  );
  return messages.flatMap((message): Message[] => {
    if (inputs.has(message.id)) return [];
    if (!message.workflowRunId) return [message];
    if (isWorkflowOpen(message.workflowPhase) || message.status === "streaming")
      return [];
    const title = message.workflow?.title ?? "工作流";
    const label = message.workflowPhase
      ? workflowPhaseLabels[message.workflowPhase]
      : "已结束";
    const text = message.text.trim().slice(0, 2000);
    return [
      {
        ...message,
        role: "assistant",
        status: "complete",
        text: `[${title} · ${label}]${
          text
            ? `
${text}`
            : ""
        }`,
      },
    ];
  });
}
