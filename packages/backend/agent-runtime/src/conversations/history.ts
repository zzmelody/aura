import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import { conversationPromptText } from "@aura/protocol/conversations";
import type {
  SessionController,
  SessionHistoryRecord,
  SessionWireEvent,
} from "@deepseek-ai/dsh-api-session-controller";
import type {
  CodingConversationInfo,
  CodingTurnUsage,
} from "@aura/protocol/types";
import { turnTokenUsage } from "./usage.ts";
import { agentFailure } from "@aura/dsh-auth/agent-failure";
import type {
  CodingFileDiff,
  CodingHistoryTurn,
  CodingQuestionAnswer,
  CodingTimelineEvent,
} from "../types.ts";
import {
  messageText as text,
  projectCodingEvent,
  toolResult,
} from "./activity.ts";
import {
  approvalAnswer,
  approvalQuestion,
  codingQuestions,
} from "./questions.ts";

/** Messages per page when walking a stored log back to its start. */
const PAGE_MESSAGES = 200;
/** Upper bound on pages read for one conversation. */
const MAX_PAGES = 50;

/**
 * Reads a session's stored log, oldest event first, through DSH's
 * message-aligned paging (the same path Flow history uses, so it works after a
 * host restart). Returns `undefined` when the session was never stored.
 *
 * @param maxPages - stop after this many pages; 1 is enough to test existence.
 */
export async function readSessionEvents(
  controller: Pick<SessionController, "follow" | "page">,
  sessionId: SessionId,
  signal: AbortSignal,
  maxPages = MAX_PAGES,
): Promise<SessionWireEvent[] | undefined> {
  const address = { kind: "session" as const, sessionId };
  const abort = new AbortController();
  const follow = controller.follow(
    { address, maxMessages: PAGE_MESSAGES },
    AbortSignal.any([signal, abort.signal]),
  );
  const frames = follow[Symbol.asyncIterator]();
  let records: SessionHistoryRecord[];
  let hasMore: boolean;
  let cursor: number;
  try {
    const first = await frames.next();
    if (first.done || first.value.type !== "snapshot") return undefined;
    records = [...first.value.records];
    hasMore = first.value.hasMore;
    cursor = first.value.cursor;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  } finally {
    abort.abort();
    await frames.return?.().catch(() => undefined);
  }
  for (let page = 1; hasMore && page < maxPages; page++) {
    const oldest = records.find((record) => record.type === "event");
    if (!oldest) break;
    const older = await controller.page(
      {
        address,
        throughSeq: cursor,
        beforeSeq: oldest.event.seq,
        maxMessages: PAGE_MESSAGES,
      },
      signal,
    );
    if (!older.records.length) break;
    records = [...older.records, ...records];
    hasMore = older.hasMore;
  }
  return records.flatMap((record) =>
    record.type === "event" ? [record.event] : [],
  );
}

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  return (
    value?.code === "session/not-found" ||
    value?.name === "ApiSessionNotFound" ||
    (typeof value?.message === "string" && /not found/iu.test(value.message))
  );
}

/** Reads a turn-aligned window using DSH's stable log cut, without replaying older turns. */
export async function readSessionEventPage(
  controller: Pick<SessionController, "follow" | "page">,
  sessionId: SessionId,
  signal: AbortSignal,
  options: {
    beforeSeq?: number;
    throughSeq?: number;
    minimumSeq?: number;
  } = {},
): Promise<{
  events: SessionWireEvent[];
  beforeSeq?: number;
  throughSeq: number;
  hasMore: boolean;
}> {
  const address = { kind: "session" as const, sessionId };
  const turnWindow = { minMessages: 20, minTurns: 10 };
  let records: readonly SessionHistoryRecord[];
  let hasMore: boolean;
  let throughSeq = options.throughSeq ?? 0;
  if (options.beforeSeq !== undefined && options.throughSeq !== undefined) {
    const page = await controller.page(
      {
        address,
        throughSeq,
        beforeSeq: options.beforeSeq,
        maxMessages: PAGE_MESSAGES,
        turnWindow,
      },
      signal,
    );
    records = page.records;
    hasMore = page.hasMore;
  } else {
    const abort = new AbortController();
    const stream = controller.follow(
      { address, maxMessages: PAGE_MESSAGES, turnWindow },
      AbortSignal.any([signal, abort.signal]),
    );
    const frames = stream[Symbol.asyncIterator]();
    try {
      const first = await frames.next();
      if (first.done || first.value.type !== "snapshot")
        return { events: [], throughSeq, hasMore: false };
      records = first.value.records;
      hasMore = first.value.hasMore;
      throughSeq = first.value.cursor;
    } catch (error) {
      if (isNotFound(error)) return { events: [], throughSeq, hasMore: false };
      throw error;
    } finally {
      abort.abort();
      await frames.return?.().catch(() => undefined);
    }
  }
  const minimum = options.minimumSeq ?? 0;
  for (let pages = 1; hasMore && pages < MAX_PAGES; pages++) {
    if (
      records.some(
        (record) =>
          record.event.type === "turn/start" && record.event.seq >= minimum,
      )
    )
      break;
    const first = records[0];
    if (!first || first.event.seq <= minimum) break;
    const older = await controller.page(
      {
        address,
        throughSeq,
        beforeSeq: first.event.seq,
        maxMessages: PAGE_MESSAGES,
        turnWindow,
      },
      signal,
    );
    if (!older.records.length) {
      hasMore = false;
      break;
    }
    records = [...older.records, ...records];
    hasMore = older.hasMore;
  }
  const start = records.findIndex(
    (record) =>
      record.event.type === "turn/start" && record.event.seq >= minimum,
  );
  const selected =
    start < 0
      ? []
      : records.slice(start).filter((record) => record.event.seq >= minimum);
  const beforeSeq = selected[0]?.event.seq;
  return {
    events: selected.map(({ event }) => event),
    beforeSeq,
    throughSeq,
    hasMore:
      beforeSeq !== undefined &&
      hasMore &&
      (records[0]?.event.seq ?? minimum) > minimum,
  };
}

/** One stored session event, as DSH's wire DTO carries it. */
export interface StoredEvent {
  type: string;
  seq?: number;
  time: number;
  data: unknown;
  usage?: CodingTurnUsage;
}

/** Keep native event boundaries for exact usage on both cold and live history. */
export function sessionHistoryTurns(
  events: ReadonlyArray<SessionEvent | SessionWireEvent>,
  live: boolean,
): CodingHistoryTurn[] {
  let start: number | undefined;
  return historyTurns(
    events.map((event, index) => {
      if (event.type === "turn/start") start = index;
      if (event.type !== "turn/end") return event;
      const from = start;
      start = undefined;
      if (from === undefined) return event;
      const usage = turnTokenUsage(events.slice(from, index + 1));
      return usage ? { ...event, usage } : event;
    }),
    live,
  );
}

/**
 * Rebuilds a coding conversation from its DSH session log, so a reloaded page
 * shows the same transcript the live stream produced: each turn's prompt, tool
 * activity, diffs, progress, questions with their answers, reply and outcome.
 *
 * Live and replayed turns share `projectCodingEvent`, so the two cannot drift.
 * Questions still waiting are left out here; the caller appends them from the
 * pending store, which holds the ids an answer must quote.
 *
 * @param events - the session log in order.
 * @param live - whether the agent is running in this process; an unfinished
 *   turn in a log nobody is driving any more is reported as stopped.
 */
export function historyTurns(
  events: readonly StoredEvent[],
  live: boolean,
): CodingHistoryTurn[] {
  const turns: CodingHistoryTurn[] = [];
  let current: CodingHistoryTurn | undefined;
  let wroteText = false;
  const created = new Map<string, CodingFileDiff>();
  // Calls and approvals asked but not yet resolved, keyed by their log id.
  const asked = new Map<string, CodingTimelineEvent>();
  const emit = (event: CodingTimelineEvent) => current?.events.push(event);

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "turn/start") {
      current = {
        turnId: `turn-${event.seq}`,
        prompt: "",
        startedAt: event.time,
        status: "running",
        events: [],
      };
      turns.push(current);
      wroteText = false;
      continue;
    }
    if (!current) {
      if (event.type.startsWith("compaction/"))
        projectCodingEvent(
          event,
          (activity) => turns.at(-1)?.events.push(activity),
          created,
        );
      continue;
    }
    if (event.type === "user/message") {
      const source = (data as { source?: { kind?: unknown; round?: unknown } })
        .source;
      // The turn's opening request, then any steering the user sent into it
      // while it ran. On replay the opening request is identified by its
      // position. Later messages retain their ID in the shared projector.
      if (source?.kind === "user" && !current.prompt) {
        current.prompt = conversationPromptText(
          text((data as { content?: unknown }).content),
        );
        continue;
      }
      if (
        source?.kind === "goal" &&
        typeof source.round === "number" &&
        !current.prompt
      ) {
        current.prompt = `目标续跑 · 第 ${source.round} 轮`;
        continue;
      }
      projectCodingEvent(event, emit, created, () => false);
      continue;
    }
    if (event.type === "assistant/message") {
      emit({ type: "model", phase: "end", at: event.time });
      if (data.interrupted === true) continue;
      const reply = text((data.message as { content?: unknown })?.content);
      if (reply) {
        emit({ type: "delta", text: wroteText ? `\n\n${reply}` : reply });
        wroteText = true;
      }
      continue;
    }
    if (event.type === "turn/end") {
      const reason = data.reason as
        { kind?: string; error?: { message?: string } } | undefined;
      current.endedAt = event.time;
      if (reason?.kind === "completed" && event.usage)
        emit({ type: "usage", usage: event.usage });
      if (reason?.kind === "completed" && event.seq !== undefined)
        current.endSeq = event.seq;
      current.status =
        reason?.kind === "completed"
          ? "complete"
          : reason?.kind === "aborted"
            ? "stopped"
            : "error";
      if (reason?.kind === "error")
        current.error = agentFailure(reason.error?.message).message;
      if (reason?.kind === "blocked") current.error = "这一轮被策略阻止了。";
      current = undefined;
      continue;
    }
    // A question shows as asked-then-answered; the call id stands in for the
    // pending id, which is gone once the question was answered.
    if (event.type === "tool/call" && data.name === "ask_user_question") {
      const questions = codingQuestions(questionArgs(data.arguments));
      if (typeof data.callId === "string" && questions.length)
        asked.set(data.callId, {
          type: "question",
          questionId: data.callId,
          questions,
        });
    }
    if (event.type === "tool/result") {
      const block = resultBlock(data);
      const question = block && asked.get(block.toolCallId);
      if (block && question?.type === "question") {
        asked.delete(block.toolCallId);
        emit(question);
        const answers = askAnswers(block.text);
        if (answers)
          emit({ type: "answered", questionId: question.questionId, answers });
      }
    }
    if (event.type === "approval/asked" && typeof data.id === "string") {
      asked.set(data.id, {
        type: "question",
        questionId: data.id,
        questions: [
          approvalQuestion(
            typeof data.toolName === "string" ? data.toolName : "tool",
            typeof data.reason === "string" ? data.reason : undefined,
          ),
        ],
      });
      continue;
    }
    if (event.type === "approval/decided" && typeof data.id === "string") {
      const question = asked.get(data.id);
      asked.delete(data.id);
      const answer =
        typeof data.outcome === "string"
          ? approvalAnswer(data.outcome)
          : undefined;
      // An approval nobody saw (no answerer) has nothing worth showing.
      if (question && answer) {
        emit(question);
        emit({ type: "answered", questionId: data.id, answers: [answer] });
      }
      continue;
    }
    projectCodingEvent(event, emit, created);
  }

  if (current && !live) {
    current.status = "stopped";
    current.endedAt ??= events.at(-1)?.time ?? current.startedAt;
  }
  return turns.filter((turn) => turn.prompt || turn.events.length);
}

/**
 * Reads only the last page of a session log to find the outcome of its most
 * recent turn. Returns `undefined` when the session has no stored events or
 * its log is unreadable. Never throws; a single page covers the vast majority
 * of coding conversations without walking their entire history.
 */
export async function lastTurnStatus(
  controller: Pick<SessionController, "follow" | "page">,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<CodingConversationInfo["lastTurnStatus"]> {
  const events = await readSessionEvents(
    controller,
    sessionId,
    signal,
    /* maxPages */ 1,
  );
  if (!events) return undefined;
  // Walk backwards: the very last turn/end tells us the outcome; if a
  // turn/start appears before we find a turn/end the last turn is still open.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "turn/end") {
      const reason = (ev.data as { reason?: { kind?: string } } | undefined)
        ?.reason;
      if (reason?.kind === "completed") return "complete";
      if (reason?.kind === "aborted") return "stopped";
      return "error";
    }
    if (ev.type === "turn/start") return "running";
  }
  return undefined;
}

function questionArgs(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as { questions?: unknown };
    return Array.isArray(parsed.questions)
      ? parsed.questions.map((item) => {
          // The tool spells it `multi_select`; Aura's DTO uses `multiSelect`.
          const value = item as Record<string, unknown> | null;
          return value && value.multi_select === true
            ? { ...value, multiSelect: true }
            : item;
        })
      : [];
  } catch {
    return [];
  }
}

function resultBlock(
  data: Record<string, unknown>,
): { toolCallId: string; text: string } | undefined {
  const result = toolResult(data);
  return result
    ? { toolCallId: result.toolCallId, text: text(result.content) }
    : undefined;
}

/** `ask_user_question` returns `{ answers: [...] }` as its JSON result text. */
function askAnswers(raw: string): CodingQuestionAnswer[] | undefined {
  try {
    const parsed = JSON.parse(raw) as { answers?: unknown };
    if (!Array.isArray(parsed.answers)) return undefined;
    return parsed.answers.flatMap((item) => {
      const answer = item as {
        id?: unknown;
        selected?: unknown;
        custom?: unknown;
      } | null;
      if (typeof answer?.id !== "string") return [];
      return [
        {
          id: answer.id,
          selected: Array.isArray(answer.selected)
            ? answer.selected.filter(
                (label): label is string => typeof label === "string",
              )
            : [],
          ...(typeof answer.custom === "string"
            ? { custom: answer.custom }
            : {}),
        },
      ];
    });
  } catch {
    return undefined;
  }
}
