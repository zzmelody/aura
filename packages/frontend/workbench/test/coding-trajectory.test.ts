import { test } from "node:test";
import assert from "node:assert/strict";
import { language, messageText } from "@aura/i18n/runtime";
import {
  applyTurnEvent,
  finishTurn,
  newTurn,
} from "../src/features/coding/turns.ts";
import {
  buildTrajectory,
  formatSpan,
} from "../src/features/coding/trajectory.ts";

function sampleTurn() {
  let turn = newTurn("s-0", "修复构建", 1_000);
  for (const event of [
    { type: "model", phase: "start", at: 1_010 },
    { type: "model", phase: "end", at: 1_400 },
    {
      type: "tool",
      phase: "start",
      callId: "c1",
      name: "bash",
      detail: "pnpm test",
      at: 1_410,
    },
    { type: "steer", text: "只跑单测", at: 1_500 },
    { type: "tool", phase: "end", callId: "c1", ok: false, at: 2_410 },
    { type: "model", phase: "start", at: 2_420 },
  ] as const)
    turn = applyTurnEvent(turn, event);
  return turn;
}

test("trajectory spans carry session times on three lanes", () => {
  const trajectory = buildTrajectory([sampleTurn()], 3_000);
  const instance = language.i18n.cloneInstance({ lng: "zh-CN" });
  assert.deepEqual(
    trajectory.spans.map(({ lane, label, start, end, state, open }) => ({
      lane,
      label: messageText(label, instance),
      start,
      end,
      state,
      open,
    })),
    [
      {
        lane: "input",
        label: "用户输入",
        start: 1_000,
        end: 1_001,
        state: "ok",
        open: false,
      },
      {
        lane: "model",
        label: "模型请求 #1",
        start: 1_010,
        end: 1_400,
        state: "ok",
        open: false,
      },
      {
        lane: "tool",
        label: "bash",
        start: 1_410,
        end: 2_410,
        state: "failed",
        open: false,
      },
      {
        lane: "input",
        label: "追加指引",
        start: 1_500,
        end: 1_501,
        state: "ok",
        open: false,
      },
      {
        lane: "model",
        label: "模型请求 #2",
        start: 2_420,
        end: 3_000,
        state: "running",
        open: true,
      },
    ],
  );
  assert.equal(trajectory.start, 1_000);
  assert.equal(trajectory.end, 3_000);
});

test("a settled turn closes open spans at its end, not at now", () => {
  const turn = finishTurn(sampleTurn(), "stopped", 2_600);
  const model = buildTrajectory([turn], 9_000).spans.at(-1)!;
  assert.equal(model.end, 2_600);
  assert.equal(model.state, "stopped");
  assert.equal(model.open, false);
});

test("span durations format compactly", () => {
  assert.equal(formatSpan(820, "en"), "820 ms");
  assert.equal(formatSpan(4_200, "en"), "4.2 sec");
  assert.equal(formatSpan(42_000, "en"), "42 sec");
  assert.equal(formatSpan(185_000, "en"), "3 min, 5 sec");
  assert.equal(formatSpan(179_900, "en"), "3 min, 0 sec");
  assert.equal(formatSpan(4_200, "fr"), "4,2 s");
});

test("trajectory labels change language without rebuilding time ranges or changing source text", () => {
  const trajectory = buildTrajectory([sampleTurn()], 3000);
  const input = trajectory.spans[0]!;
  const times = trajectory.spans.map(({ start, end }) => [start, end]);
  const texts = new Set<string>();
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
    const instance = language.i18n.cloneInstance({ lng: locale });
    texts.add(messageText(input.label, instance));
    assert.equal(input.detail, "修复构建");
    assert.equal(
      messageText(
        trajectory.spans.find((item) => item.lane === "tool")!.label,
        instance,
      ),
      "bash",
    );
  }
  assert.equal(texts.size, 6);
  assert.deepEqual(
    trajectory.spans.map(({ start, end }) => [start, end]),
    times,
  );
});
