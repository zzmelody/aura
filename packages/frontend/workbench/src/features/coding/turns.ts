import type {
  CodingActivity,
  CodingFileDiff,
  CodingHistoryTurn,
  CodingQuestionAnswer,
  CodingQuestionItem,
} from "@aura/protocol/types";
import type { ChatImage } from "@aura/core/types";

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
  /** Images sent with this request; only known for turns sent from this page. */
  images?: ChatImage[];
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

export function newTurn(
  id: string,
  prompt: string,
  startedAt: number,
  images?: ChatImage[],
): Turn {
  return {
    id,
    prompt,
    ...(images?.length ? { images } : {}),
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

/** Tools that run a shell command; their detail is the command line. */
const SHELL_TOOLS = new Set(["bash", "pwsh"]);

/** What a finished turn changed and ran, for the end-of-turn summary. */
export type TurnSummary = {
  /** Files written or edited, in first-touched order, with line counts. */
  files: Array<{ path: string; added: number; removed: number }>;
  /** Shell commands, in run order, with their outcome. */
  commands: Array<{ command: string; ok: boolean }>;
  /** Steps that failed, other than commands (already listed above). */
  failedSteps: number;
  /** Questions the agent asked that were never answered. */
  unanswered: number;
};

/**
 * Summarises a turn from its own steps. `countLines` turns one hunk into
 * added/removed counts; it is injected so this module stays free of the
 * diff renderer.
 */
export function summarizeTurn(
  turn: Turn,
  countLines: (diff: CodingFileDiff) => { added: number; removed: number },
): TurnSummary {
  const files = new Map<string, { added: number; removed: number }>();
  const commands: TurnSummary["commands"] = [];
  let failedSteps = 0;
  for (const tool of turn.tools) {
    for (const diff of tool.diffs ?? []) {
      const counted = countLines(diff);
      const entry = files.get(diff.path) ?? { added: 0, removed: 0 };
      files.set(diff.path, {
        added: entry.added + counted.added,
        removed: entry.removed + counted.removed,
      });
    }
    if (SHELL_TOOLS.has(tool.name)) {
      if (tool.detail && tool.state !== "running")
        commands.push({ command: tool.detail, ok: tool.state === "ok" });
    } else if (tool.state === "failed") failedSteps++;
  }
  return {
    files: [...files].map(([path, counts]) => ({ path, ...counts })),
    commands,
    failedSteps,
    unanswered: turn.questions.filter((item) => !item.answered).length,
  };
}

/** A summary is worth showing only when the turn changed or ran something. */
export function hasSummary(summary: TurnSummary): boolean {
  return summary.files.length > 0 || summary.commands.length > 0;
}

/**
 * Fallback summary of a side chat when the model did not write one: its last
 * reply, or the files and commands it touched.
 */
export function handoffPrompt(
  turns: readonly Turn[],
  countLines: (diff: CodingFileDiff) => { added: number; removed: number },
): string {
  const last = turns
    .map((turn) => turn.reply.trim())
    .filter(Boolean)
    .at(-1);
  if (last) return last;
  const files = new Map<string, { added: number; removed: number }>();
  const commands: Array<{ command: string; ok: boolean }> = [];
  for (const turn of turns) {
    const summary = summarizeTurn(turn, countLines);
    for (const file of summary.files) {
      const current = files.get(file.path) ?? { added: 0, removed: 0 };
      files.set(file.path, {
        added: current.added + file.added,
        removed: current.removed + file.removed,
      });
    }
    commands.push(...summary.commands);
  }
  const lines: string[] = ["旁支对话没有文字结论。"];
  if (files.size) {
    lines.push("改动了这些文件：");
    for (const [path, counts] of files)
      lines.push(`- ${path}（+${counts.added} −${counts.removed}）`);
  }
  if (commands.length) {
    lines.push("运行了这些命令：");
    for (const item of commands)
      lines.push(`- \`${item.command}\`（${item.ok ? "成功" : "失败"}）`);
  }
  if (lines.length === 1) lines.push("没有改文件，也没有跑命令。");
  return lines.join("\n");
}
