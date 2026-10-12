import type {
  CodingActivity,
  CodingFileDiff,
  CodingHistoryTurn,
  CodingQuestionAnswer,
  CodingQuestionItem,
} from "@aura/protocol/types";

export type ToolEntry = {
  callId: string;
  name: string;
  /** The file, command or pattern the call touches, when it names one. */
  detail?: string;
  state: "running" | "ok" | "failed";
  /** Applied hunks of a write or edit. */
  diffs?: CodingFileDiff[];
};

export type AskedQuestion = {
  questionId: string;
  questions: CodingQuestionItem[];
  /** Set once the user answered; an open question has none. */
  answered?: CodingQuestionAnswer[];
};

/** One request and everything the agent did to answer it. */
export type Turn = {
  id: string;
  prompt: string;
  reply: string;
  tools: ToolEntry[];
  progress?: { done: number; total: number };
  deliverables: string[];
  /** Questions the agent asked during this turn, answered or still open. */
  questions: AskedQuestion[];
  status: "running" | "complete" | "stopped" | "error";
  error?: string;
  startedAt: number;
  endedAt?: number;
};

/** A reply fragment or one activity entry, live or replayed. */
export type TurnEvent = { type: "delta"; text: string } | CodingActivity;

export function newTurn(id: string, prompt: string, startedAt: number): Turn {
  return {
    id,
    prompt,
    reply: "",
    tools: [],
    deliverables: [],
    questions: [],
    status: "running",
    startedAt,
  };
}

/**
 * Folds one event into a turn. The live stream and replayed history both go
 * through here, so a reloaded transcript looks exactly like the live one.
 */
export function applyTurnEvent(turn: Turn, event: TurnEvent): Turn {
  if (event.type === "delta")
    return { ...turn, reply: turn.reply + event.text };
  if (event.type === "progress")
    return { ...turn, progress: { done: event.done, total: event.total } };
  if (event.type === "deliverable")
    return turn.deliverables.includes(event.path)
      ? turn
      : { ...turn, deliverables: [...turn.deliverables, event.path] };
  if (event.type === "question")
    return turn.questions.some((item) => item.questionId === event.questionId)
      ? turn
      : {
          ...turn,
          questions: [
            ...turn.questions,
            { questionId: event.questionId, questions: event.questions },
          ],
        };
  if (event.type === "answered")
    return answerTurn(turn, event.questionId, event.answers);
  if (event.phase === "start")
    return {
      ...turn,
      tools: [
        ...turn.tools,
        {
          callId: event.callId,
          name: event.name,
          ...(event.detail ? { detail: event.detail } : {}),
          state: "running",
        },
      ],
    };
  return {
    ...turn,
    tools: turn.tools.map((tool) =>
      tool.callId === event.callId
        ? {
            ...tool,
            state: event.ok ? "ok" : "failed",
            ...(event.diffs?.length ? { diffs: event.diffs } : {}),
          }
        : tool,
    ),
  };
}

/** Marks a question answered. */
export function answerTurn(
  turn: Turn,
  questionId: string,
  answers: CodingQuestionAnswer[],
): Turn {
  return {
    ...turn,
    questions: turn.questions.map((item) =>
      item.questionId === questionId ? { ...item, answered: answers } : item,
    ),
  };
}

/**
 * Rebuilds the studio's turns from replayed history. A turn that is no longer
 * running cannot still be waiting on a step, so leftover running steps are
 * shown as failed rather than spinning forever.
 */
export function turnsFromHistory(
  sessionId: string,
  history: readonly CodingHistoryTurn[],
): Turn[] {
  return history.map((item, index) => {
    let turn = newTurn(`${sessionId}-${index}`, item.prompt, item.startedAt);
    for (const event of item.events) turn = applyTurnEvent(turn, event);
    turn = {
      ...turn,
      status: item.status,
      ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
      ...(item.error ? { error: item.error } : {}),
    };
    if (item.status !== "running")
      turn = {
        ...turn,
        tools: turn.tools.map((tool) =>
          tool.state === "running" ? { ...tool, state: "failed" } : tool,
        ),
      };
    return turn;
  });
}
