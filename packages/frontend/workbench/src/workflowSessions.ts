import type { Message, Workspace } from "@aura/core/types";
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

export function mergeWorkflowRuns(
  state: Workspace,
  runs: FlowRunSummary[],
  endpoint: string,
  importUnknown = true,
): Workspace {
  let sessions = state.sessions;
  const hidden = new Set(state.hiddenWorkflowRuns);
  for (const run of runs) {
    const found = sessions.find(
      (session) =>
        session.workflow?.endpoint === endpoint &&
        session.messages.some((message) => message.workflowRunId === run.id),
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
    if (session.workflow?.endpoint !== endpoint) return session;
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
