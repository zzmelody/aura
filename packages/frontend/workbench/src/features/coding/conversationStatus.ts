import type { CodingConversationInfo } from "@aura/protocol/types";
import type { SessionStatus } from "../../sidebarSessions.ts";
import type { Turn } from "./turns.ts";

const RUNNING: SessionStatus = { kind: "running", messageKey: "executing" };
const CONNECTING: SessionStatus = { kind: "queued", messageKey: "connecting" };
const WAITING: SessionStatus = { kind: "waiting", messageKey: "waitingAnswer" };
const COMPLETED: SessionStatus = { kind: "completed", messageKey: "completed" };
const STOPPED: SessionStatus = { kind: "stopped", messageKey: "stopped" };
const FAILED: SessionStatus = { kind: "failed", messageKey: "executionFailed" };

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
 * A conversation stays running while any of its side chats runs, even after
 * the main conversation's own turn has settled.
 */
export function withSideActivity(
  status: SessionStatus | undefined,
  sideRunning: boolean,
): SessionStatus | undefined {
  if (!sideRunning) return status;
  return status?.kind === "running" ||
    status?.kind === "waiting" ||
    status?.kind === "queued"
    ? status
    : RUNNING;
}

/**
 * Sidebar status of one workspace conversation, from its latest turn. A
 * conversation with no turns loaded on this page has no known status.
 */
export function codingConversationStatus(
  turns: readonly Turn[],
): SessionStatus | undefined {
  const last = turns.at(-1);
  if (!last) return undefined;
  if (last.status === "running" && last.waitingForService) return CONNECTING;
  if (last.status === "running")
    return last.questions.some((item) => !item.answered) ? WAITING : RUNNING;
  if (last.status === "complete") return COMPLETED;
  if (last.status === "stopped") return STOPPED;
  return FAILED;
}
