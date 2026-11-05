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
