import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodingHistoryTurn } from "@aura/protocol/types";
import {
  HANDOFF_SUMMARY_PROMPT,
  answerTurn,
  applyTurnEvent,
  finishTurn,
  handoffResult,
  newTurn,
  pendingQuestion,
  reconcileFinishedTurn,
  reusableHandoffSummary,
  summarizeTurn,
  turnPresentation,
  turnsFromHistory,
  type TurnEvent,
} from "../src/features/coding/turns.ts";

test("turn reconciliation restores the recorded outcome and preserves local attachments", () => {
  const image = {
    assetId: "image",
    name: "图",
    mimeType: "image/png",
  } as const;
  const local = newTurn("local", "", 10, [image]);
  const recorded: CodingHistoryTurn = {
    prompt: "请查看我附上的图片。",
    startedAt: 11,
    endedAt: 12,
    status: "complete",
    events: [{ type: "delta", text: "已查看" }],
  };
  const result = reconcileFinishedTurn(local, recorded, 15);
  assert.equal(result.id, "local");
  assert.equal(result.prompt, "");
  assert.deepEqual(result.images, [image]);
  assert.equal(result.status, "complete");
  assert.equal(result.endedAt, 12);
  assert.equal(result.reply, "已查看");
});

test("turn reconciliation never copies a result from an earlier identical prompt", () => {
  const local = applyTurnEvent(newTurn("local", "检查", 10), {
    type: "delta",
    text: "当前输出",
  });
  const result = reconcileFinishedTurn(
    local,
    {
      prompt: "检查",
      startedAt: 1,
      endedAt: 2,
      status: "complete",
      events: [{ type: "delta", text: "早先的输出" }],
    },
    15,
  );
  assert.equal(result.status, "error");
  assert.equal(result.reply, "当前输出");
});

const events: TurnEvent[] = [
  { type: "tool", phase: "start", callId: "c1", name: "write", detail: "a.ts" },
  {
    type: "tool",
    phase: "end",
    callId: "c1",
    ok: true,
    diffs: [{ path: "a.ts", oldText: null, newText: "x\n" }],
  },
  { type: "progress", done: 1, total: 2 },
  {
    type: "question",
    questionId: "q1",
    questions: [{ id: "s", question: "哪种？", options: [{ label: "A" }] }],
  },
  {
    type: "answered",
    questionId: "q1",
    answers: [{ id: "s", selected: ["A"] }],
  },
  { type: "deliverable", path: "a.ts" },
  { type: "deliverable", path: "a.ts" },
  { type: "delta", text: "完成" },
];

test("workflow references are replayable and duplicate live notifications do not duplicate cards", () => {
  const event = {
    type: "workflow" as const,
    runId: "run",
    flowId: "test/flow",
    title: "测试工作流",
    inputPreview: "{}",
  };
  const turn = applyTurnEvent(
    applyTurnEvent(newTurn("t", "运行", 1), event),
    event,
  );
  assert.equal(turn.workflows?.length, 1);
  assert.deepEqual(turn.timeline, [{ kind: "workflow", runId: "run" }]);
  const replayed = turnsFromHistory("session", [
    { prompt: "运行", startedAt: 1, status: "complete", events: [event] },
  ]);
  assert.deepEqual(replayed[0]!.workflows, turn.workflows);
  assert.deepEqual(replayed[0]!.timeline, turn.timeline);
});

test("completion and history retain the interleaved assistant, tool, approval and guidance sequence", () => {
  const steps: TurnEvent[] = [
    { type: "delta", text: "先检查项目。" },
    { type: "tool", phase: "start", callId: "read", name: "read", at: 2 },
    { type: "tool", phase: "end", callId: "read", ok: true, at: 3 },
    { type: "delta", text: "需要运行命令。" },
    { type: "tool", phase: "start", callId: "shell", name: "pwsh", at: 4 },
    {
      type: "question",
      questionId: "approval",
      questions: [{ id: "allow", kind: "approval", question: "允许？" }],
    },
    {
      type: "answered",
      questionId: "approval",
      answers: [{ id: "allow", selected: ["允许"] }],
    },
    { type: "tool", phase: "end", callId: "shell", ok: true, at: 5 },
    { type: "steer", text: "也检查一下构建。", at: 6 },
    { type: "delta", text: "开始构建。" },
    {
      type: "workflow",
      runId: "build",
      flowId: "build",
      title: "构建",
      inputPreview: "{}",
    },
    { type: "delta", text: "检查完成。" },
  ];
  const live = steps.reduce(applyTurnEvent, newTurn("s-0", "检查", 1));
  const finished = finishTurn(live, "complete", 9);
  const [replayed] = turnsFromHistory("s", [
    {
      prompt: "检查",
      startedAt: 1,
      endedAt: 9,
      status: "complete",
      events: steps,
    },
  ]);
  assert.deepEqual(finished.timeline, [
    { kind: "text", text: "先检查项目。" },
    { kind: "tools", callIds: ["read"] },
    { kind: "text", text: "需要运行命令。" },
    { kind: "tools", callIds: ["shell"] },
    { kind: "question", questionId: "approval" },
    { kind: "steer", text: "也检查一下构建。" },
    { kind: "text", text: "开始构建。" },
    { kind: "workflow", runId: "build" },
    { kind: "text", text: "检查完成。" },
  ]);
  assert.deepEqual(replayed, finished);
  assert.deepEqual(turnPresentation(replayed), {
    canCollapse: false,
    finalReplyIndex: 8,
  });
  assert.equal(finished.questions[0]!.answered?.[0]!.selected[0], "允许");
});

test("completed work can fold around its final reply in live and replayed turns", () => {
  const steps: TurnEvent[] = [
    { type: "steer", text: "先检查测试。", at: 2 },
    { type: "delta", text: "先看当前文件。" },
    { type: "tool", phase: "start", callId: "read", name: "read", at: 3 },
    { type: "tool", phase: "end", callId: "read", ok: true, at: 4 },
    { type: "delta", text: "检查通过。" },
    { type: "notice", id: "note", text: "已更新上下文。", at: 5 },
  ];
  const live = steps.reduce(applyTurnEvent, newTurn("s-0", "检查", 1));
  for (const turn of [
    live,
    finishTurn(live, "error", 6, "执行失败"),
    finishTurn(live, "stopped", 6),
  ])
    assert.equal(turnPresentation(turn).canCollapse, false);

  const [replayed] = turnsFromHistory("s", [
    {
      prompt: "检查",
      startedAt: 1,
      endedAt: 6,
      status: "complete",
      events: steps,
    },
  ]);
  for (const turn of [finishTurn(live, "complete", 6), replayed!]) {
    assert.deepEqual(turnPresentation(turn), {
      canCollapse: true,
      finalReplyIndex: 3,
    });
    assert.deepEqual(turn.timeline[3], { kind: "text", text: "检查通过。" });
  }
});

test("a progress reply before the last tool stays in the process when there is no final reply", () => {
  const steps: TurnEvent[] = [
    { type: "delta", text: "开始构建。" },
    { type: "tool", phase: "start", callId: "build", name: "bash", at: 2 },
    { type: "tool", phase: "end", callId: "build", ok: true, at: 3 },
    { type: "delta", text: "\n" },
  ];
  const turn = finishTurn(
    steps.reduce(applyTurnEvent, newTurn("t", "构建", 1)),
    "complete",
    4,
  );
  assert.deepEqual(turnPresentation(turn), {
    canCollapse: true,
    finalReplyIndex: -1,
  });
});

test("a plain reply has no execution record to fold", () => {
  const turn = finishTurn(
    applyTurnEvent(newTurn("t", "你好", 1), { type: "delta", text: "你好！" }),
    "complete",
    2,
  );
  assert.deepEqual(turnPresentation(turn), {
    canCollapse: false,
    finalReplyIndex: 0,
  });
});

test("events fold into tools, progress, questions, deliverables and reply", () => {
  const turn = events.reduce(applyTurnEvent, newTurn("t", "写个函数", 1));
  assert.equal(turn.reply, "完成");
  assert.deepEqual(turn.progress, { done: 1, total: 2 });
  assert.deepEqual(turn.deliverables, ["a.ts"]);
  assert.equal(turn.tools.length, 1);
  assert.equal(turn.tools[0]!.state, "ok");
  assert.equal(turn.tools[0]!.detail, "a.ts");
  assert.equal(turn.tools[0]!.diffs?.length, 1);
  assert.equal(turn.questions.length, 1);
  assert.deepEqual(turn.questions[0]!.answered, [{ id: "s", selected: ["A"] }]);
});

test("a repeated question event is not shown twice", () => {
  const question = events[3]!;
  const turn = [question, question].reduce(applyTurnEvent, newTurn("t", "", 1));
  assert.equal(turn.questions.length, 1);
});

test("the timeline retains text, grouped tools and questions in arrival order", () => {
  const tool: TurnEvent = {
    type: "tool",
    phase: "start",
    callId: "c1",
    name: "read",
  };
  const steps: TurnEvent[] = [
    { type: "delta", text: "先" },
    { type: "delta", text: "看看" },
    tool,
    tool,
    { type: "delta", text: "\n" },
    { type: "tool", phase: "start", callId: "c2", name: "grep" },
    events[3]!,
    events[3]!,
    { type: "delta", text: "完成" },
  ];
  const turn = steps.reduce(applyTurnEvent, newTurn("t", "", 1));
  assert.deepEqual(turn.timeline, [
    { kind: "text", text: "先看看" },
    { kind: "tools", callIds: ["c1", "c2"] },
    { kind: "question", questionId: "q1" },
    { kind: "text", text: "完成" },
  ]);
  assert.equal(turn.tools.length, 2);
  assert.equal(turn.reply, "先看看\n完成");
});

test("steering is its own entry and does not merge the reply around it", () => {
  const turn = (
    [
      { type: "delta", text: "先看看" },
      { type: "steer", text: "改用 map" },
      { type: "delta", text: "改好了" },
    ] satisfies TurnEvent[]
  ).reduce(applyTurnEvent, newTurn("t", "写个函数", 1));
  assert.deepEqual(turn.timeline, [
    { kind: "text", text: "先看看" },
    { kind: "steer", text: "改用 map" },
    { kind: "text", text: "改好了" },
  ]);
  // The reply is the turn's whole text; the bubble renders from the timeline.
  assert.equal(turn.reply, "先看看改好了");
});

test("replayed history matches the live fold and keeps its outcome", () => {
  const history: CodingHistoryTurn[] = [
    {
      prompt: "写个函数",
      startedAt: 1,
      endedAt: 9,
      status: "complete",
      events,
    },
  ];
  const [replayed] = turnsFromHistory("s1", history);
  const live = events.reduce(applyTurnEvent, newTurn("s1-0", "写个函数", 1));
  assert.deepEqual(replayed, { ...live, status: "complete", endedAt: 9 });
});

test("a step left running in a stopped turn shows as interrupted, not failed", () => {
  const [turn] = turnsFromHistory("s1", [
    {
      prompt: "跑命令",
      startedAt: 1,
      endedAt: 5,
      status: "stopped",
      events: [{ type: "tool", phase: "start", callId: "c9", name: "bash" }],
    },
  ]);
  assert.equal(turn!.status, "stopped");
  assert.equal(turn!.tools[0]!.state, "stopped");
});

for (const status of ["complete", "stopped", "error"] as const) {
  test(`live and replayed ${status} settle unfinished tools without changing recorded outcomes`, () => {
    const steps: TurnEvent[] = [
      ...events,
      { type: "tool", phase: "start", callId: "bad", name: "read" },
      { type: "tool", phase: "end", callId: "bad", ok: false },
      {
        type: "tool",
        phase: "start",
        callId: "pending",
        name: "bash",
        detail: "pnpm test",
      },
    ];
    const live = steps.reduce(applyTurnEvent, newTurn("s1-0", "验证", 1));
    const error = status === "error" ? "连接中断" : undefined;
    const finished = finishTurn(live, status, 9, error);
    const [replayed] = turnsFromHistory("s1", [
      {
        prompt: "验证",
        startedAt: 1,
        endedAt: 9,
        status,
        events: steps,
        error,
      },
    ]);
    assert.deepEqual(finished, replayed);
    assert.equal(finished.tools[0]!.state, "ok");
    assert.equal(finished.tools[1]!.state, "failed");
    assert.equal(
      finished.tools[2]!.state,
      status === "error" ? "failed" : "stopped",
    );
    assert.equal(live.tools[2]!.state, "running");
    const summary = summarizeTurn(finished, () => ({ added: 0, removed: 0 }));
    assert.equal(summary.commands.length, status === "error" ? 1 : 0);
  });
}

test("a turn still running keeps its open step running", () => {
  const [turn] = turnsFromHistory("s1", [
    {
      prompt: "跑命令",
      startedAt: 1,
      status: "running",
      events: [{ type: "tool", phase: "start", callId: "c9", name: "bash" }],
    },
  ]);
  assert.equal(turn!.tools[0]!.state, "running");
  assert.equal(turn!.endedAt, undefined);
});

test("a turn summary lists changed files, commands and loose ends", () => {
  let turn = newTurn("t", "改一下", 1);
  const steps: TurnEvent[] = [
    {
      type: "tool",
      phase: "start",
      callId: "w1",
      name: "edit",
      detail: "a.ts",
    },
    {
      type: "tool",
      phase: "end",
      callId: "w1",
      ok: true,
      diffs: [{ path: "a.ts", oldText: "x\n", newText: "y\n" }],
    },
    {
      type: "tool",
      phase: "start",
      callId: "w2",
      name: "edit",
      detail: "a.ts",
    },
    {
      type: "tool",
      phase: "end",
      callId: "w2",
      ok: true,
      diffs: [{ path: "a.ts", oldText: null, newText: "z\n" }],
    },
    {
      type: "tool",
      phase: "start",
      callId: "b1",
      name: "bash",
      detail: "pnpm test",
    },
    { type: "tool", phase: "end", callId: "b1", ok: false },
    {
      type: "tool",
      phase: "start",
      callId: "r1",
      name: "read",
      detail: "b.ts",
    },
    { type: "tool", phase: "end", callId: "r1", ok: false },
    {
      type: "question",
      questionId: "q1",
      questions: [{ id: "s", question: "继续吗？" }],
    },
  ];
  for (const step of steps) turn = applyTurnEvent(turn, step);
  const summary = summarizeTurn(turn, (diff) => ({
    added: diff.newText.split("\n").filter(Boolean).length,
    removed: diff.oldText?.split("\n").filter(Boolean).length ?? 0,
  }));
  // Two edits of one file merge into one entry with summed counts.
  assert.deepEqual(summary.files, [{ path: "a.ts", added: 2, removed: 1 }]);
  assert.deepEqual(summary.commands, [{ command: "pnpm test", ok: false }]);
  assert.equal(summary.steps, 4);
  assert.equal(summary.reads, 0);
  assert.equal(summary.failedSteps, 1);
  assert.equal(summary.unanswered, 1);
});

test("the oldest open question of a running turn owns the composer card", () => {
  const ask = (questionId: string): TurnEvent => ({
    type: "question",
    questionId,
    questions: [{ id: questionId, question: `${questionId}？` }],
  });
  const settled = finishTurn(
    applyTurnEvent(newTurn("settled", "问完了", 1), ask("finished")),
    "complete",
    2,
  );
  const running = applyTurnEvent(
    applyTurnEvent(newTurn("running", "在问", 3), ask("first")),
    {
      type: "question",
      questionId: "approval",
      questions: [{ id: "approve", kind: "approval", question: "允许？" }],
    },
  );
  // A finished turn keeps its record but no longer owns the decision.
  assert.equal(pendingQuestion([settled]), undefined);
  assert.deepEqual(pendingQuestion([settled, running]), {
    turnId: "running",
    asked: running.questions[0],
  });
  const oneAnswered = answerTurn(running, "first", []);
  assert.equal(
    pendingQuestion([settled, oneAnswered])?.asked.questionId,
    "approval",
  );
  const allAnswered = answerTurn(oneAnswered, "approval", [
    { id: "approve", selected: ["拒绝"] },
  ]);
  assert.equal(pendingQuestion([settled, allAnswered]), undefined);
});

test("a turn that only reads files reports no changed files", () => {
  let turn = newTurn("t", "看看", 1);
  turn = applyTurnEvent(turn, {
    type: "tool",
    phase: "start",
    callId: "r1",
    name: "read",
    detail: "a.ts",
  });
  turn = applyTurnEvent(turn, {
    type: "tool",
    phase: "end",
    callId: "r1",
    ok: true,
  });
  const summary = summarizeTurn(turn, () => ({ added: 0, removed: 0 }));
  assert.equal(summary.reads, 1);
  assert.deepEqual(summary.files, []);
});

const noLines = () => ({ added: 0, removed: 0 });

/** A settled turn with the given prompt and reply. */
function settledTurn(
  id: string,
  prompt: string,
  reply: string,
  status: "complete" | "stopped" | "error" = "complete",
) {
  return finishTurn(
    applyTurnEvent(newTurn(id, prompt, 1), { type: "delta", text: reply }),
    status,
    2,
  );
}

test("a completed summary turn becomes the hand-off", () => {
  const earlier = settledTurn("a", "分析一下", "早期结论");
  const summary = settledTurn("s", HANDOFF_SUMMARY_PROMPT, "  交接结论  ");
  assert.deepEqual(handoffResult(summary, [earlier, summary], noLines), {
    kind: "summary",
    text: "交接结论",
  });
});

test("a failed or empty summary falls back to the earlier conversation", () => {
  const earlier = settledTurn("a", "分析一下", "早期结论");
  for (const summary of [
    settledTurn("s", HANDOFF_SUMMARY_PROMPT, "半截", "error"),
    settledTurn("s", HANDOFF_SUMMARY_PROMPT, "   "),
  ])
    assert.deepEqual(handoffResult(summary, [earlier, summary], noLines), {
      kind: "fallback",
      text: "早期结论",
    });
  // A refused send (no turn) also falls back instead of handing off nothing.
  assert.deepEqual(handoffResult(undefined, [earlier], noLines), {
    kind: "fallback",
    text: "早期结论",
  });
});

test("stopping the summary turn cancels the hand-off", () => {
  const summary = settledTurn("s", HANDOFF_SUMMARY_PROMPT, "半截", "stopped");
  assert.deepEqual(handoffResult(summary, [summary], noLines), {
    kind: "cancelled",
  });
});

test("only a finished summary that is still the latest turn is reused", () => {
  const earlier = settledTurn("a", "分析一下", "早期结论");
  const summary = settledTurn("s", HANDOFF_SUMMARY_PROMPT, "交接结论");
  assert.equal(reusableHandoffSummary([earlier, summary]), "交接结论");
  // A later turn may change the conclusion, so the summary is stale.
  const later = settledTurn("b", "再看看", "新结论");
  assert.equal(reusableHandoffSummary([summary, later]), undefined);
  assert.equal(
    reusableHandoffSummary([
      earlier,
      settledTurn("s", HANDOFF_SUMMARY_PROMPT, "半截", "error"),
    ]),
    undefined,
  );
  assert.equal(
    reusableHandoffSummary([settledTurn("s", HANDOFF_SUMMARY_PROMPT, " ")]),
    undefined,
  );
  assert.equal(reusableHandoffSummary([]), undefined);
});
