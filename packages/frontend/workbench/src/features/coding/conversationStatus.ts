import type { CodingConversationInfo } from "@aura/protocol/types";
import type { SessionStatus } from "../../sidebarSessions.ts";
import type { Turn } from "./turns.ts";

const RUNNING: SessionStatus = { kind: "running", label: "正在执行" };
const WAITING: SessionStatus = { kind: "waiting", label: "等待你的回答" };
const COMPLETED: SessionStatus = { kind: "completed", label: "已完成" };
const STOPPED: SessionStatus = { kind: "stopped", label: "已停止" };
const FAILED: SessionStatus = { kind: "failed", label: "执行失败" };

/**
 * Sidebar status reported by the server for a listed conversation, so every
 * row has a badge whether or not it was opened on this page.
 */
export function conversationInfoStatus(
  info: CodingConversationInfo,
): SessionStatus | undefined {
  switch (info.lastTurnStatus) {
    case "running":
      return info.waitingForAnswer ? WAITING : RUNNING;
    case "complete":
      return COMPLETED;
    case "stopped":
      return STOPPED;
    case "error":
      return FAILED;
    default:
      return undefined;
  }
}

/** Whether a status still changes on its own and is worth polling for. */
export const isActiveStatus = (status: SessionStatus | undefined) =>
  status?.kind === "running" || status?.kind === "waiting";

/**
 * Sidebar status of one workspace conversation, from its latest turn. A
 * conversation with no turns loaded on this page has no known status.
 */
export function codingConversationStatus(
  turns: readonly Turn[],
): SessionStatus | undefined {
  const last = turns.at(-1);
  if (!last) return undefined;
  if (last.status === "running")
    return last.questions.some((item) => !item.answered) ? WAITING : RUNNING;
  if (last.status === "complete") return COMPLETED;
  if (last.status === "stopped") return STOPPED;
  return FAILED;
}
