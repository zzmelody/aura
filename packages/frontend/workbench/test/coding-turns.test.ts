import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodingHistoryTurn } from "@aura/protocol/types";
import {
  applyTurnEvent,
  newTurn,
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

test("a step left running in a finished turn shows as failed, not spinning", () => {
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
  assert.equal(turn!.tools[0]!.state, "failed");
});

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
