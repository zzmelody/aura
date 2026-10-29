import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodingHistoryTurn } from "@aura/protocol/types";
import {
  applyTurnEvent,
  finishTurn,
  hasSummary,
  newTurn,
  recapParts,
  summarizeTurn,
  turnsFromHistory,
  type TurnEvent,
} from "../src/features/coding/turns.ts";

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
  const replayed = turnsFromHistory("session", [
    { prompt: "运行", startedAt: 1, status: "complete", events: [event] },
  ]);
  assert.deepEqual(replayed[0]!.workflows, turn.workflows);
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
  assert.equal(hasSummary(summary), true);
  assert.deepEqual(recapParts(summary), [
    "改动 1 个文件",
    "运行 1 条命令（1 条失败）",
    "1 个步骤失败",
    "1 个问题未回答",
  ]);
});

test("a turn that only read files still recaps what it did", () => {
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
  assert.equal(hasSummary(summary), true);
  assert.equal(summary.reads, 1);
  assert.deepEqual(recapParts(summary), ["读取 1 个文件"]);
});
