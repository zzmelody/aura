import type {
  CodingActivity,
  ChatWorkflowStart,
  CodingFileDiff,
  CodingHistoryTurn,
  CodingQuestionAnswer,
  CodingQuestionItem,
  CodingTurnUsage,
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
  startedAt: number;
  endedAt?: number;
};

export type ToolGroupSummary = {
  total: number;
  finished: number;
  failed: number;
  stopped: number;
  state: ToolEntry["state"];
  active?: ToolEntry;
};

const toolGroupActivities: Record<string, readonly [string, string]> = {
  web_search: ["搜索了网页", "尝试搜索网页"],
  web_fetch: ["读取了网页", "尝试读取网页"],
  subagent: ["委派了子 Agent", "尝试委派子 Agent"],
  read: ["读取了文件", "尝试读取文件"],
  read_image: ["查看了图片", "尝试查看图片"],
  glob: ["搜索了项目", "尝试搜索项目"],
  grep: ["搜索了项目", "尝试搜索项目"],
  write: ["修改了文件", "尝试修改文件"],
  edit: ["修改了文件", "尝试修改文件"],
  bash: ["运行了命令", "尝试运行命令"],
  pwsh: ["运行了命令", "尝试运行命令"],
  todo_write: ["更新了任务清单", "尝试更新任务清单"],
  present: ["交付了文件", "尝试交付文件"],
};

/** Describe the work once per activity, without claiming failed edits succeeded. */
export function describeToolGroup(tools: readonly ToolEntry[]): string {
  const activities = new Map<
    string,
    { attempted: string; succeeded: boolean }
  >();
  for (const tool of tools) {
    const [done, attempted] = toolGroupActivities[tool.name] ?? [
      "调用了工具",
      "尝试调用工具",
    ];
    activities.set(done, {
      attempted,
      succeeded: tool.state === "ok" || !!activities.get(done)?.succeeded,
    });
  }
  return [...activities]
    .map(([done, activity]) => (activity.succeeded ? done : activity.attempted))
    .join("、");
}

/** A collapsed run keeps failures visible even while another call is active. */
export function summarizeToolGroup(
  tools: readonly ToolEntry[],
): ToolGroupSummary {
  let running = 0;
  let failed = 0;
  let stopped = 0;
  let active: ToolEntry | undefined;
  for (const tool of tools) {
    if (tool.state === "running") {
      running++;
      active = tool;
    } else if (tool.state === "failed") failed++;
    else if (tool.state === "stopped") stopped++;
  }
  return {
    total: tools.length,
    finished: tools.length - running,
    failed,
    stopped,
    state: running ? "running" : failed ? "failed" : stopped ? "stopped" : "ok",
    ...(active ? { active } : {}),
  };
}

/** One model request: from step start to its assistant message. */
export type ModelSpan = { startedAt: number; endedAt?: number };

export type AskedQuestion = {
  questionId: string;
  questions: CodingQuestionItem[];
  /** Set once the user answered; an open question has none. */
  answered?: CodingQuestionAnswer[];
};

/** An open question batch and the turn that is waiting on it. */
export type PendingQuestion = { turnId: string; asked: AskedQuestion };

/**
 * The batch that owns the card above the composer: the oldest unanswered one
 * in a running turn. The decision and its record live in different places, so
 * only that batch may hide its transcript entry.
 */
export function pendingQuestion(
  turns: readonly Turn[],
): PendingQuestion | undefined {
  for (const turn of turns) {
    if (turn.status !== "running") continue;
    const asked = turn.questions.find((item) => item.answered === undefined);
    if (asked) return { turnId: turn.id, asked };
  }
  return undefined;
}

/**
 * One entry of a turn in the order the agent produced it: some text, a run of
 * consecutive tool calls, or a question. Rendering this list replays the real
 * flow (think, act, explain, act again) instead of all tools then all text.
 */
export type TimelineItem =
  | { kind: "notice"; id: string; text: string }
  | { kind: "web"; event: Extract<CodingActivity, { type: "web" }> }
  | { kind: "text"; text: string }
  | { kind: "tools"; callIds: string[] }
  | { kind: "question"; questionId: string }
  | { kind: "workflow"; runId: string }
  /** Guidance the user sent while this turn was running. */
  | SteerEntry;

type SteerEntry = {
  kind: "steer";
  text: string;
  requestId?: string;
  images?: ChatImage[];
  delivery?: "waiting" | "unconfirmed";
};

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
  workflows?: ChatWorkflowStart[];
  /** Model requests in order, for the trajectory. */
  models: ModelSpan[];
  /** When each steering message arrived. */
  steers: number[];
  status: "running" | "complete" | "stopped" | "error";
  /** Local admission only; no model request has been sent yet. */
  waitingForService?: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
  endSeq?: number;
  usage?: CodingTurnUsage;
};

/** A reply fragment or one activity entry, live or replayed. */
export type TurnEvent = { type: "delta"; text: string } | CodingActivity;

/** Identify the reply after the last activity and whether work can fold as one. */
export function turnPresentation(turn: Turn): {
  finalReplyIndex: number;
  canCollapse: boolean;
} {
  let finalReplyIndex = -1;
  let hasOutput = false;
  let hasProcess = Boolean(turn.progress?.total);
  let hasInterleavedInput = false;
  for (const [index, item] of turn.timeline.entries()) {
    if (item.kind === "steer") {
      hasInterleavedInput ||= hasOutput;
      if (!item.delivery) finalReplyIndex = -1;
    } else if (item.kind === "text" && item.text.trim()) {
      hasOutput = true;
      finalReplyIndex = index;
    } else if (
      item.kind === "tools" ||
      item.kind === "question" ||
      item.kind === "workflow"
    ) {
      hasProcess ||= item.kind === "tools" || finalReplyIndex >= 0;
      hasOutput = true;
      finalReplyIndex = -1;
    }
  }
  return {
    finalReplyIndex,
    canCollapse:
      turn.status === "complete" && hasProcess && !hasInterleavedInput,
  };
}

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
    models: [],
    steers: [],
    status: "running",
    startedAt,
  };
}

/**
 * Folds one event into a turn. The live stream and replayed history both go
 * through here, so a reloaded transcript looks exactly like the live one.
 */
export function applyTurnEvent(turn: Turn, event: TurnEvent): Turn {
  if (event.type === "usage") return { ...turn, usage: event.usage };
  if (event.type === "turn-boundary") return { ...turn, endSeq: event.endSeq };
  if (event.type === "notice") {
    const item: TimelineItem = {
      kind: "notice",
      id: event.id,
      text: event.text,
    };
    const index = turn.timeline.findIndex(
      (entry) => entry.kind === "notice" && entry.id === event.id,
    );
    return {
      ...turn,
      timeline:
        index < 0
          ? [...turn.timeline, item]
          : turn.timeline.map((entry, at) => (at === index ? item : entry)),
    };
  }
  if (event.type === "web")
    return { ...turn, timeline: [...turn.timeline, { kind: "web", event }] };
  if (event.type === "workflow")
    return turn.workflows?.some((run) => run.runId === event.runId)
      ? turn
      : {
          ...turn,
          workflows: [...(turn.workflows ?? []), event],
          timeline: [
            ...turn.timeline,
            { kind: "workflow", runId: event.runId },
          ],
        };
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
  if (event.type === "model") {
    const open = turn.models.at(-1);
    if (event.phase === "start")
      return { ...turn, models: [...turn.models, { startedAt: event.at }] };
    return open && open.endedAt === undefined
      ? {
          ...turn,
          models: [...turn.models.slice(0, -1), { ...open, endedAt: event.at }],
        }
      : turn;
  }
  if (event.type === "steer") {
    const index = event.requestId
      ? turn.timeline.findIndex(
          (item) => item.kind === "steer" && item.requestId === event.requestId,
        )
      : -1;
    const existing = turn.timeline[index];
    if (existing?.kind === "steer" && !existing.delivery) return turn;
    const item: SteerEntry =
      existing?.kind === "steer"
        ? { ...existing, delivery: undefined }
        : {
            kind: "steer",
            text: event.text,
            ...(event.requestId ? { requestId: event.requestId } : {}),
          };
    return {
      ...turn,
      steers: [...turn.steers, event.at],
      timeline:
        index < 0
          ? [...turn.timeline, item]
          : turn.timeline.map((entry, at) => (at === index ? item : entry)),
    };
  }
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
              startedAt: event.at,
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
            endedAt: event.at,
            ...(event.diffs?.length ? { diffs: event.diffs } : {}),
          }
        : tool,
    ),
  };
}

/** Show the user message at its submission position before DSH reads it. */
export function addPendingSteer(
  turn: Turn,
  requestId: string,
  text: string,
  images: ChatImage[],
): Turn {
  return {
    ...turn,
    timeline: [
      ...turn.timeline,
      {
        kind: "steer",
        requestId,
        text,
        ...(images.length ? { images } : {}),
        delivery: "waiting",
      },
    ],
  };
}

/** A failed admission can only change an entry the agent has yet to read. */
export function settlePendingSteer(
  turn: Turn,
  requestId: string,
  delivery?: "unconfirmed",
): Turn {
  return {
    ...turn,
    timeline: turn.timeline.flatMap((item) => {
      if (
        item.kind !== "steer" ||
        item.requestId !== requestId ||
        !item.delivery
      )
        return [item];
      return delivery ? [{ ...item, delivery }] : [];
    }),
  };
}

/** DSH can consume a parked message in a later turn after cancellation. */
export function confirmConversationSteer(
  turns: readonly Turn[],
  turnId: string,
  event: Extract<CodingActivity, { type: "steer" }>,
): Turn[] {
  const original = event.requestId
    ? turns.find((turn) =>
        turn.timeline.some(
          (item) => item.kind === "steer" && item.requestId === event.requestId,
        ),
      )
    : undefined;
  const target = original?.id ?? turnId;
  return turns.map((turn) =>
    turn.id === target ? applyTurnEvent(turn, event) : turn,
  );
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
    if (item.endSeq !== undefined) turn.endSeq = item.endSeq;
    for (const event of item.events) turn = applyTurnEvent(turn, event);
    return item.status === "running"
      ? turn
      : finishTurn(turn, item.status, item.endedAt, item.error);
  });
}

/** A restored running turn has history snapshots in place of a live stream. */
export function confirmRecordedSteers(
  turn: Turn,
  recorded: CodingHistoryTurn,
): Turn {
  if (recorded.startedAt !== turn.startedAt) return turn;
  const pendingIds = new Set(
    turn.timeline.flatMap((item) =>
      item.kind === "steer" && item.delivery ? [item.requestId] : [],
    ),
  );
  return recorded.events.reduce(
    (current, event) =>
      event.type === "steer" &&
      event.requestId &&
      pendingIds.has(event.requestId)
        ? applyTurnEvent(current, event)
        : current,
    turn,
  );
}

/** Recover a stale local turn only after the backend has reported idle. */
export function reconcileFinishedTurn(
  turn: Turn,
  recorded: CodingHistoryTurn | undefined,
  checkedAt: number,
): Turn {
  if (turn.status === "complete" || turn.status === "stopped") return turn;
  const prompt = turn.prompt || "请查看我附上的图片。";
  if (
    recorded &&
    recorded.status !== "running" &&
    recorded.startedAt >= turn.startedAt &&
    recorded.prompt === prompt
  ) {
    const [restored] = turnsFromHistory(turn.id, [recorded]);
    const sent = new Map<string, SteerEntry>();
    for (const item of turn.timeline)
      if (item.kind === "steer" && item.requestId)
        sent.set(item.requestId, item);
    const timeline = restored!.timeline.map((item) => {
      if (item.kind !== "steer" || !item.requestId) return item;
      const local = sent.get(item.requestId);
      if (!local) return item;
      sent.delete(item.requestId);
      return { ...local, delivery: undefined };
    });
    timeline.push(...Array.from(sent.values()).filter((item) => item.delivery));
    return {
      ...restored!,
      timeline,
      id: turn.id,
      prompt: turn.prompt,
      images: turn.images,
    };
  }
  return turn.status === "running"
    ? finishTurn(
        turn,
        "error",
        checkedAt,
        "本轮已结束，历史中没有可确认的结果。",
      )
    : turn;
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

/** Asks the side chat's model to write its own hand-off for the main chat. */
export const HANDOFF_SUMMARY_PROMPT = `请把这段侧边对话整理成交接给主对话的结论，只输出结论本身：
1. 结论：讨论或任务的最终结果
2. 关键决定与理由
3. 改动的文件与执行过的命令（如有）
4. 尚未解决的问题或需要主对话继续处理的事项
没有内容的小节直接省略，保持简洁，不复述过程。`;

/**
 * A summary turn that already finished as the side chat's latest turn; handing
 * off again reuses it instead of asking the model a second time.
 */
export function reusableHandoffSummary(
  turns: readonly Turn[],
): string | undefined {
  const last = turns.at(-1);
  if (
    last?.prompt.trim() !== HANDOFF_SUMMARY_PROMPT ||
    last.status !== "complete"
  )
    return undefined;
  return last.reply.trim() || undefined;
}

export type HandoffResult =
  | { kind: "summary"; text: string }
  | { kind: "fallback"; text: string }
  | { kind: "cancelled" };

/**
 * Picks what goes back to the main chat once the summary turn settles: the
 * model's summary, the deterministic fallback when it failed or said nothing,
 * or nothing when the user stopped it.
 */
export function handoffResult(
  summaryTurn: Turn | undefined,
  turns: readonly Turn[],
  countLines: (diff: CodingFileDiff) => { added: number; removed: number },
): HandoffResult {
  if (summaryTurn?.status === "stopped") return { kind: "cancelled" };
  const text = summaryTurn?.status === "complete" && summaryTurn.reply.trim();
  if (text) return { kind: "summary", text };
  // The failed summary turn itself carries no conclusion of the side chat.
  const earlier = summaryTurn
    ? turns.filter((turn) => turn.id !== summaryTurn.id)
    : turns;
  return { kind: "fallback", text: handoffPrompt(earlier, countLines) };
}
