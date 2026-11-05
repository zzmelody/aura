import { test } from "node:test";
import assert from "node:assert/strict";
import {
  historyTurns,
  type StoredEvent,
} from "../src/conversations/history.ts";
import { projectCodingEvent } from "../src/conversations/activity.ts";
import type { CodingFileDiff, CodingStreamEvent } from "../src/types.ts";

const userMessage = (text: string, rpcId?: string): StoredEvent => ({
  type: "user/message",
  time: 0,
  data: {
    source: { kind: "user", ...(rpcId ? { rpcId } : {}) },
    content: [{ type: "text", text }],
  },
});

const assistantMessage = (text: string, turn: number): StoredEvent => ({
  type: "assistant/message",
  time: 0,
  data: { turn, message: { content: [{ type: "text", text }] } },
});

/**
 * Steering joins the turn it redirects, so a replayed transcript keeps the
 * opening request as the turn's prompt and shows every later user message as
 * its own entry, in the order the user sent them.
 */
test("replay keeps the turn's prompt and projects later messages as steering", () => {
  const turns = historyTurns(
    [
      { type: "turn/start", time: 0, data: { turn: 1 } },
      userMessage("写个函数"),
      assistantMessage("好，先看文件", 1),
      userMessage("改用 map"),
      assistantMessage("改好了", 1),
      {
        type: "turn/end",
        time: 1,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ],
    /* live */ false,
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.prompt, "写个函数");
  assert.deepEqual(turns[0]!.events, [
    { type: "model", phase: "end", at: 0 },
    { type: "delta", text: "好，先看文件" },
    { type: "steer", text: "改用 map", at: 0 },
    { type: "model", phase: "end", at: 0 },
    { type: "delta", text: "\n\n改好了" },
  ]);
});

/** Each turn's own opening request stays its prompt, never the one before. */
test("replay does not carry steering across a turn boundary", () => {
  const turns = historyTurns(
    [
      { type: "turn/start", time: 0, data: { turn: 1 } },
      userMessage("第一轮"),
      {
        type: "turn/end",
        time: 1,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      { type: "turn/start", time: 2, data: { turn: 2 } },
      userMessage("第二轮"),
      {
        type: "turn/end",
        time: 3,
        data: { turn: 2, reason: { kind: "completed" } },
      },
    ],
    /* live */ false,
  );
  assert.deepEqual(
    turns.map((turn) => ({ prompt: turn.prompt, events: turn.events })),
    [
      { prompt: "第一轮", events: [] },
      { prompt: "第二轮", events: [] },
    ],
  );
});

/**
 * The live stream tells its own request apart by `rpcId`, which replay cannot
 * see. Both must reach the same entry, or a reload would show a different
 * transcript than the turn did.
 */
test("the live projection matches replay for the same messages", () => {
  const emitted: CodingStreamEvent[] = [];
  const created = new Map<string, CodingFileDiff>();
  const own = (message: Record<string, unknown>) =>
    (message.source as { rpcId?: unknown } | undefined)?.rpcId === "req-1";
  for (const event of [
    userMessage("写个函数", "req-1"),
    userMessage("改用 map"),
  ])
    projectCodingEvent(event, (value) => emitted.push(value), created, own);
  assert.deepEqual(emitted, [{ type: "steer", text: "改用 map", at: 0 }]);
});

/** Only what the user typed; other producers carry their own source kind. */
test("injected context and other producers are not shown as steering", () => {
  const emitted: CodingStreamEvent[] = [];
  const created = new Map<string, CodingFileDiff>();
  projectCodingEvent(
    {
      type: "user/message",
      time: 0,
      data: {
        source: { kind: "notice", summary: "文件有改动" },
        content: [{ type: "text", text: "a.ts 已被外部修改" }],
      },
    },
    (value) => emitted.push(value),
    created,
    () => false,
  );
  assert.deepEqual(emitted, []);
});

/** A caller that tracks prompts itself opts out by omitting the test. */
test("without the prompt test no user message is projected", () => {
  const emitted: CodingStreamEvent[] = [];
  const created = new Map<string, CodingFileDiff>();
  projectCodingEvent(
    userMessage("改用 map"),
    (value) => emitted.push(value),
    created,
  );
  assert.deepEqual(emitted, []);
});

test("parked steering before a new turn's ordinary prompt is not mistaken for that prompt", () => {
  const pending = "00000000-0000-4000-8000-000000000001";
  const continuation = "00000000-0000-4000-8000-000000000002";
  const events: StoredEvent[] = [
    { type: "turn/start", time: 0, data: { turn: 1 } },
    userMessage("检查项目"),
    {
      type: "agent/inbox/spliced",
      time: 1,
      data: {
        target: "next-step",
        start: 0,
        inserted: [
          {
            id: "message",
            source: { kind: "user", rpcId: pending },
            content: [{ type: "text", text: "改用 Angel" }],
          },
        ],
      },
    },
    {
      type: "turn/end",
      time: 2,
      data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } },
    },
    { type: "turn/start", time: 3, data: { turn: 2 } },
    { type: "step/start", time: 3, data: { turn: 2, step: 1 } },
    userMessage("改用 Angel", pending),
    userMessage("继续", continuation),
    { type: "request/header", time: 4, data: {} },
    assistantMessage("继续处理", 2),
    {
      type: "turn/end",
      time: 5,
      data: { turn: 2, reason: { kind: "completed" } },
    },
  ];
  const before = historyTurns(events.slice(0, 4), false);
  assert.deepEqual(before[0]?.events, [
    {
      type: "steer",
      text: "改用 Angel",
      requestId: pending,
      delivery: "queued",
      at: 1,
    },
  ]);
  const after = historyTurns(events, false);
  assert.deepEqual(
    after.map((turn) => turn.prompt),
    ["检查项目", "继续"],
  );
  assert.deepEqual(after[0]?.events, [
    { type: "steer", text: "改用 Angel", requestId: pending, at: 0 },
  ]);
  assert.equal(
    after[1]?.events.some((event) => event.type === "steer"),
    false,
  );
  // A bounded history page may begin after the original enqueue event.
  const page = historyTurns(events.slice(4), false);
  assert.equal(page[0]?.prompt, "继续");
  assert.deepEqual(
    page[0]?.events.filter((event) => event.type === "steer"),
    [{ type: "steer", text: "改用 Angel", requestId: pending, at: 0 }],
  );
});

test("history distinguishes retained steering from input DSH explicitly canceled", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const queued = [first, second].map((rpcId) => ({
    id: rpcId,
    source: { kind: "user", rpcId },
    content: [{ type: "text", text: "追加指令" }],
  }));
  const [turn] = historyTurns(
    [
      { type: "turn/start", time: 0, data: { turn: 1 } },
      userMessage("检查"),
      {
        type: "agent/inbox/spliced",
        time: 1,
        data: { target: "next-step", start: 0, inserted: queued },
      },
      {
        type: "turn/end",
        time: 2,
        data: { turn: 1, reason: { kind: "aborted" } },
      },
      {
        type: "agent/inbox/spliced",
        time: 3,
        data: {
          target: "next-step",
          start: 0,
          removedCount: 1,
          inserted: [],
          outcome: "canceled",
        },
      },
    ],
    false,
  );
  assert.deepEqual(
    turn?.events.map(
      (event) => event.type === "steer" && [event.requestId, event.delivery],
    ),
    [
      [first, "canceled"],
      [second, "queued"],
    ],
  );
});

test("parked steering does not replace a goal continuation prompt", () => {
  const [turn] = historyTurns(
    [
      { type: "turn/start", time: 0, data: { turn: 2 } },
      { type: "step/start", time: 0, data: { turn: 2, step: 1 } },
      userMessage("先检查测试", "00000000-0000-4000-8000-000000000001"),
      {
        type: "user/message",
        time: 0,
        data: {
          source: { kind: "goal", round: 2 },
          content: [{ type: "text", text: "继续目标" }],
        },
      },
      { type: "request/header", time: 0, data: {} },
      {
        type: "turn/end",
        time: 1,
        data: { turn: 2, reason: { kind: "completed" } },
      },
    ],
    false,
  );
  assert.equal(turn?.prompt, "目标续跑 · 第 2 轮");
  assert.equal(turn?.events[1]?.type, "steer");
});
