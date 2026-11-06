import type { Session } from "@aura/core/types";
import { formatRelativeTime, language } from "@aura/i18n/runtime";
import { isWorkflowActive } from "./workflowSessions.ts";
import {
  sidebarMessage,
  workflowPhaseMessageKeys,
  type SidebarMessageKey,
} from "./sidebar-messages.ts";

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
  /** Resolve at render time so cached statuses follow the selected language. */
  messageKey: SidebarMessageKey;
};

/** Compact row metadata; callers may supply a clock for deterministic rendering. */
export function sidebarSessionTime(
  updatedAt: number,
  now = Date.now(),
  locale = language.getSnapshot().locale,
): string {
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return "—";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60)
    return language.i18n.t("justNow", { ns: "sidebar", lng: locale });
  const relative = (size: number, unit: Intl.RelativeTimeFormatUnit) =>
    formatRelativeTime(-Math.floor(seconds / size), unit, locale, {
      style: "narrow",
      numeric: "always",
    });
  if (seconds < 3600) return relative(60, "minute");
  if (seconds < 86400) return relative(3600, "hour");
  if (seconds < 30 * 86400) return relative(86400, "day");
  if (seconds < 365 * 86400) return relative(30 * 86400, "month");
  return relative(365 * 86400, "year");
}

/**
 * A sidebar row shows either a status icon or its time, never both. Only
 * states worth noticing earn the icon; settled rows, including one the user
 * stopped, fall back to the time as in DSH.
 */
export function sidebarRowStatus(
  status: SessionStatus | undefined,
): SessionStatus | undefined {
  return status &&
    status.kind !== "completed" &&
    status.kind !== "idle" &&
    status.kind !== "stopped"
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
    return { kind: "attention", messageKey: "waitingInput" };
  if (phases.includes("needs_attention"))
    return { kind: "attention", messageKey: "attention" };
  if (phases.includes("pausing"))
    return { kind: "running", messageKey: "pausing" };
  if (phases.includes("running"))
    return { kind: "running", messageKey: "running" };
  if (phases.includes("queued"))
    return { kind: "queued", messageKey: "queued" };
  if (
    running ||
    session.messages.some(
      (message) => message.status === "streaming" && !message.workflowRunId,
    )
  )
    return {
      kind: "running",
      messageKey: session.workflow ? "submitting" : "generating",
    };
  if (phases.includes("paused"))
    return { kind: "paused", messageKey: "paused" };
  if (session.workflow?.pending || session.pendingWorkflow)
    return { kind: "attention", messageKey: "submissionUnknown" };
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
    return { kind, messageKey: workflowPhaseMessageKeys[last.workflowPhase] };
  }
  if (last?.status === "error")
    return { kind: "failed", messageKey: "replyFailed" };
  if (last?.status === "stopped")
    return { kind: "stopped", messageKey: "stopped" };
  if (last) return { kind: "completed", messageKey: "completed" };
  return { kind: "idle", messageKey: "idle" };
}

export function sidebarSessionTitle(session: Session): string {
  if (!session.workflow || session.title !== session.workflow.title)
    return session.title;
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
  return text.replace(/\s+/g, " ").slice(0, 80) || sidebarMessage("newRun");
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
      title: session.workflow?.title ?? sidebarMessage("conversations"),
      workflow: Boolean(session.workflow),
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(id, group);
  }
  return [...groups.values()];
}
