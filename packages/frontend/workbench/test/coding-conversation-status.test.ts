import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodingConversationInfo } from "@aura/protocol/types";
import {
  codingConversationStatus,
  conversationInfoStatus,
  isActiveStatus,
  withSideActivity,
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

test("a locally queued turn reports connecting without claiming model execution", () => {
  const turn = { ...newTurn("queued", "任务", 1), waitingForService: true };
  assert.deepEqual(codingConversationStatus([turn]), {
    kind: "queued",
    messageKey: "connecting",
  });
  assert.equal(isActiveStatus(codingConversationStatus([turn])), false);
  assert.equal(
    codingConversationStatus([{ ...turn, waitingForService: false }])?.kind,
    "running",
  );
  assert.equal(
    codingConversationStatus([finishTurn(turn, "stopped", 2)])?.kind,
    "stopped",
  );
});

test("a finished turn reports completed, stopped or failed", () => {
  assert.deepEqual(codingConversationStatus([settled("complete")]), {
    kind: "completed",
    messageKey: "completed",
  });
  assert.deepEqual(codingConversationStatus([settled("stopped")]), {
    kind: "stopped",
    messageKey: "stopped",
  });
  assert.deepEqual(codingConversationStatus([settled("error")]), {
    kind: "failed",
    messageKey: "executionFailed",
  });
});

test("an open question reports waiting, otherwise running", () => {
  const running = newTurn("t", "任务", 1);
  assert.deepEqual(codingConversationStatus([running]), {
    kind: "running",
    messageKey: "executing",
  });
  const waiting = applyTurnEvent(running, {
    type: "question",
    questionId: "q1",
    questions: [{ id: "c", question: "继续吗？" }],
  });
  assert.deepEqual(codingConversationStatus([waiting]), {
    kind: "waiting",
    messageKey: "waitingAnswer",
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

test("a running side chat keeps a settled main conversation running", () => {
  const completed = codingConversationStatus([settled("complete")]);
  assert.equal(withSideActivity(completed, false)?.kind, "completed");
  assert.equal(withSideActivity(completed, true)?.kind, "running");
  assert.equal(withSideActivity(undefined, true)?.kind, "running");
  const waiting = {
    kind: "waiting" as const,
    messageKey: "waitingAnswer" as const,
  };
  assert.equal(withSideActivity(waiting, true), waiting);
});

test("only running and waiting rows keep the sidebar polling", () => {
  assert.equal(isActiveStatus({ kind: "running", messageKey: "idle" }), true);
  assert.equal(isActiveStatus({ kind: "waiting", messageKey: "idle" }), true);
  assert.equal(
    isActiveStatus({ kind: "completed", messageKey: "idle" }),
    false,
  );
  assert.equal(isActiveStatus(undefined), false);
});

test("the latest turn wins over older settled turns", () => {
  assert.equal(
    codingConversationStatus([settled("complete"), newTurn("t2", "", 6)])?.kind,
    "running",
  );
});
