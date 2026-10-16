import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodingConversationInfo } from "@aura/protocol/types";
import {
  codingConversationStatus,
  conversationInfoStatus,
  isActiveStatus,
} from "../src/features/coding/conversationStatus.ts";
import {
  applyTurnEvent,
  finishTurn,
  newTurn,
  type Turn,
} from "../src/features/coding/turns.ts";

function settled(status: "complete" | "stopped" | "error"): Turn {
  return finishTurn(newTurn("t", "任务", 1), status, 5);
}

test("no turns means no sidebar status", () => {
  assert.equal(codingConversationStatus([]), undefined);
});

test("a finished turn reports completed, stopped or failed", () => {
  assert.deepEqual(codingConversationStatus([settled("complete")]), {
    kind: "completed",
    label: "已完成",
  });
  assert.deepEqual(codingConversationStatus([settled("stopped")]), {
    kind: "stopped",
    label: "已停止",
  });
  assert.deepEqual(codingConversationStatus([settled("error")]), {
    kind: "failed",
    label: "执行失败",
  });
});

test("an open question reports waiting, otherwise running", () => {
  const running = newTurn("t", "任务", 1);
  assert.deepEqual(codingConversationStatus([running]), {
    kind: "running",
    label: "正在执行",
  });
  const waiting = applyTurnEvent(running, {
    type: "question",
    questionId: "q1",
    questions: [{ id: "c", question: "继续吗？" }],
  });
  assert.deepEqual(codingConversationStatus([waiting]), {
    kind: "waiting",
    label: "等待你的回答",
  });
  const answered = applyTurnEvent(waiting, {
    type: "answered",
    questionId: "q1",
    answers: [{ id: "c", selected: ["继续"] }],
  });
  assert.equal(codingConversationStatus([answered])?.kind, "running");
});

const info = (
  extra: Partial<CodingConversationInfo>,
): CodingConversationInfo => ({
  id: "s",
  projectId: "p",
  title: "对话",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

test("listed conversations carry a badge without being opened", () => {
  assert.equal(conversationInfoStatus(info({})), undefined);
  assert.equal(
    conversationInfoStatus(info({ lastTurnStatus: "complete" }))?.kind,
    "completed",
  );
  assert.equal(
    conversationInfoStatus(info({ lastTurnStatus: "stopped" }))?.kind,
    "stopped",
  );
  assert.equal(
    conversationInfoStatus(info({ lastTurnStatus: "error" }))?.kind,
    "failed",
  );
  assert.equal(
    conversationInfoStatus(info({ lastTurnStatus: "running" }))?.kind,
    "running",
  );
  assert.equal(
    conversationInfoStatus(
      info({ lastTurnStatus: "running", waitingForAnswer: true }),
    )?.kind,
    "waiting",
  );
});

test("only running and waiting rows keep the sidebar polling", () => {
  assert.equal(isActiveStatus({ kind: "running", label: "" }), true);
  assert.equal(isActiveStatus({ kind: "waiting", label: "" }), true);
  assert.equal(isActiveStatus({ kind: "completed", label: "" }), false);
  assert.equal(isActiveStatus(undefined), false);
});

test("the latest turn wins over older settled turns", () => {
  assert.equal(
    codingConversationStatus([settled("complete"), newTurn("t2", "", 6)])?.kind,
    "running",
  );
});
