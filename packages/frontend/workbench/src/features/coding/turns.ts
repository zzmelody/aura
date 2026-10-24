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
  state: "running" | "ok" | "failed" | "stopped";
  /** Applied hunks of a write or edit. */
  diffs?: CodingFileDiff[];
};

export type AskedQuestion = {
  questionId: string;
  questions: CodingQuestionItem[];
  /** Set once the user answered; an open question has none. */
  answered?: CodingQuestionAnswer[];
};

/**
 * One entry of a turn in the order the agent produced it: some text, a run of
 * consecutive tool calls, or a question. Rendering this list replays the real
 * flow (think, act, explain, act again) instead of all tools then all text.
 */
export type TimelineItem =
  | { kind: "text"; text: string }
  | { kind: "tools"; callIds: string[] }
  | { kind: "question"; questionId: string }
  /** Guidance the user sent while this turn was running. */
  | { kind: "steer"; text: string };

/** One request and everything the agent did to answer it. */
export type Turn = {
  /** Text, tool runs and questions in arrival order. */
  timeline: TimelineItem[];
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
    timeline: [],
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
    return {
      ...turn,
      reply: turn.reply + event.text,
      timeline: appendText(turn.timeline, event.text),
    };
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
          timeline: [
            ...turn.timeline,
            { kind: "question", questionId: event.questionId },
          ],
        };
  if (event.type === "answered")
    return answerTurn(turn, event.questionId, event.answers);
  if (event.type === "steer")
    return {
      ...turn,
      // Guidance is its own entry, so the reply text before and after it stay
      // separate paragraphs instead of merging across the interruption.
      timeline: [...turn.timeline, { kind: "steer", text: event.text }],
    };
  if (event.phase === "start")
    return turn.tools.some((tool) => tool.callId === event.callId)
      ? turn
      : {
          ...turn,
          timeline: appendTool(turn.timeline, event.callId),
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

/** Text streams in fragments; adjacent fragments form one paragraph block. */
function appendText(
  timeline: readonly TimelineItem[],
  text: string,
): TimelineItem[] {
  if (!text) return [...timeline];
  const last = timeline.at(-1);
  return last?.kind === "text"
    ? [...timeline.slice(0, -1), { kind: "text", text: last.text + text }]
    : [...timeline, { kind: "text", text }];
}

/**
 * Consecutive calls share one group, like DSH's tool run. Whitespace-only
 * text between two calls does not split the group.
 */
function appendTool(
  timeline: readonly TimelineItem[],
  callId: string,
): TimelineItem[] {
  let end = timeline.length;
  while (end > 0) {
    const item = timeline[end - 1]!;
    if (item.kind !== "text" || item.text.trim()) break;
    end--;
  }
  const last = timeline[end - 1];
  return last?.kind === "tools"
    ? [
        ...timeline.slice(0, end - 1),
        { kind: "tools", callIds: [...last.callIds, callId] },
      ]
    : [...timeline, { kind: "tools", callIds: [callId] }];
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

/** Settle live and replayed turns alike; missing results never imply success. */
export function finishTurn(
  turn: Turn,
  status: Exclude<Turn["status"], "running">,
  endedAt?: number,
  error?: string,
): Turn {
  return {
    ...turn,
    status,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(error ? { error } : {}),
    tools: turn.tools.map((tool) =>
      tool.state === "running"
        ? { ...tool, state: status === "error" ? "failed" : "stopped" }
        : tool,
    ),
  };
}

/** Rebuild the transcript using the same settlement rules as the live stream. */
export function turnsFromHistory(
  sessionId: string,
  history: readonly CodingHistoryTurn[],
): Turn[] {
  return history.map((item, index) => {
    let turn = newTurn(`${sessionId}-${index}`, item.prompt, item.startedAt);
    for (const event of item.events) turn = applyTurnEvent(turn, event);
    return item.status === "running"
      ? turn
      : finishTurn(turn, item.status, item.endedAt, item.error);
  });
}

/** Tools that run a shell command; their detail is the command line. */
const SHELL_TOOLS = new Set(["bash", "pwsh"]);

/** Tools that only look at the project. */
const READ_TOOLS = new Set(["read", "read_image"]);
const SEARCH_TOOLS = new Set(["glob", "grep"]);

/** What a finished turn did, changed and ran, for the end-of-turn recap. */
export type TurnSummary = {
  /** Every step the turn took. */
  steps: number;
  /** Distinct files and images read. */
  reads: number;
  /** File and content searches. */
  searches: number;
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
  const read = new Set<string>();
  let searches = 0;
  let failedSteps = 0;
  for (const tool of turn.tools) {
    if (READ_TOOLS.has(tool.name) && tool.state === "ok")
      read.add(tool.detail ?? tool.callId);
    if (SEARCH_TOOLS.has(tool.name) && tool.state === "ok") searches++;
    for (const diff of tool.diffs ?? []) {
      const counted = countLines(diff);
      const entry = files.get(diff.path) ?? { added: 0, removed: 0 };
      files.set(diff.path, {
        added: entry.added + counted.added,
        removed: entry.removed + counted.removed,
      });
    }
    if (SHELL_TOOLS.has(tool.name)) {
      if (tool.detail && (tool.state === "ok" || tool.state === "failed"))
        commands.push({ command: tool.detail, ok: tool.state === "ok" });
    } else if (tool.state === "failed") failedSteps++;
  }
  return {
    steps: turn.tools.length,
    reads: read.size,
    searches,
    files: [...files].map(([path, counts]) => ({ path, ...counts })),
    commands,
    failedSteps,
    unanswered: turn.questions.filter((item) => !item.answered).length,
  };
}

/** A recap is worth showing once the turn took at least one step. */
export function hasSummary(summary: TurnSummary): boolean {
  return summary.steps > 0;
}

/**
 * The "what it did" phrases of a recap line, in the order the work usually
 * happens: look, change, verify, then anything that went wrong.
 */
export function recapParts(summary: TurnSummary): string[] {
  const parts: string[] = [];
  if (summary.reads) parts.push(`读取 ${summary.reads} 个文件`);
  if (summary.searches) parts.push(`搜索 ${summary.searches} 次`);
  if (summary.files.length) parts.push(`改动 ${summary.files.length} 个文件`);
  if (summary.commands.length) {
    const failed = summary.commands.filter((item) => !item.ok).length;
    parts.push(
      `运行 ${summary.commands.length} 条命令${failed ? `（${failed} 条失败）` : ""}`,
    );
  }
  if (summary.failedSteps) parts.push(`${summary.failedSteps} 个步骤失败`);
  if (summary.unanswered) parts.push(`${summary.unanswered} 个问题未回答`);
  return parts;
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
