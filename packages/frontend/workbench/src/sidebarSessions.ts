import type { Session } from "@aura/core/types";
import { isWorkflowActive, workflowPhaseLabels } from "./workflowSessions.ts";

export type SessionStatus = {
  kind:
    | "idle"
    | "running"
    | "queued"
    | "completed"
    | "stopped"
    | "failed"
    | "paused"
    | "attention"
    | "waiting";
  label: string;
};

/** Compact row metadata; callers may supply a clock for deterministic rendering. */
export function sidebarSessionTime(
  updatedAt: number,
  now = Date.now(),
): string {
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return "—";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}天前`;
  if (seconds < 365 * 86400)
    return `${Math.floor(seconds / (30 * 86400))}个月前`;
  return `${Math.floor(seconds / (365 * 86400))}年前`;
}

/**
 * A sidebar row shows either a status icon or its time, never both. Only
 * states worth noticing earn the icon; settled rows fall back to the time.
 */
export function sidebarRowStatus(
  status: SessionStatus | undefined,
): SessionStatus | undefined {
  return status && status.kind !== "completed" && status.kind !== "idle"
    ? status
    : undefined;
}

/** Aggregate live work first; completed older runs do not mask the latest turn. */
export function sidebarSessionStatus(
  session: Session,
  running = false,
): SessionStatus {
  const phases = session.messages.flatMap((message) =>
    message.workflowPhase ? [message.workflowPhase] : [],
  );
  if (phases.includes("waiting_input"))
    return { kind: "attention", label: "等待输入" };
  if (phases.includes("needs_attention"))
    return { kind: "attention", label: "需要处理" };
  if (phases.includes("pausing")) return { kind: "running", label: "正在暂停" };
  if (phases.includes("running")) return { kind: "running", label: "正在运行" };
  if (phases.includes("queued")) return { kind: "queued", label: "等待执行" };
  if (
    running ||
    session.messages.some(
      (message) => message.status === "streaming" && !message.workflowRunId,
    )
  )
    return {
      kind: "running",
      label: session.workflow ? "正在提交" : "正在生成",
    };
  if (phases.includes("paused")) return { kind: "paused", label: "已暂停" };
  if (session.workflow?.pending || session.pendingWorkflow)
    return { kind: "attention", label: "提交待确认" };
  const last = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (last?.workflowPhase && !isWorkflowActive(last.workflowPhase)) {
    const kind =
      last.workflowPhase === "failed"
        ? "failed"
        : last.workflowPhase === "completed"
          ? "completed"
          : "stopped";
    return { kind, label: workflowPhaseLabels[last.workflowPhase] };
  }
  if (last?.status === "error") return { kind: "failed", label: "回复失败" };
  if (last?.status === "stopped") return { kind: "stopped", label: "已停止" };
  if (last) return { kind: "completed", label: "已完成" };
  return { kind: "idle", label: "尚未开始" };
}

export function sidebarSessionTitle(session: Session): string {
  if (!session.workflow || session.title !== session.workflow.title)
    return session.title;
  if (session.workflow.id === "self-media/video") return "视频生成";
  let text =
    session.messages.find((message) => message.role === "user")?.text.trim() ??
    "";
  if (text.startsWith("{")) {
    try {
      const input: unknown = JSON.parse(text);
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const prompt = Object.values(input).find(
          (value) => typeof value === "string" && value.trim(),
        );
        if (typeof prompt === "string") text = prompt;
      }
    } catch {
      /* Truncated legacy previews remain searchable as plain text. */
    }
  }
  return text.replace(/\s+/g, " ").slice(0, 80) || "新的运行";
}

export function groupSidebarSessions(sessions: Session[]) {
  const groups = new Map<
    string,
    { id: string; title: string; workflow: boolean; sessions: Session[] }
  >();
  for (const session of sessions) {
    const id = session.workflow
      ? JSON.stringify([session.workflow.endpoint, session.workflow.id])
      : "chat";
    const group = groups.get(id) ?? {
      id,
      title: session.workflow?.title ?? "对话",
      workflow: Boolean(session.workflow),
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(id, group);
  }
  return [...groups.values()];
}
