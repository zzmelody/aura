import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTurnEvent,
  finishTurn,
  newTurn,
  summarizeTurn,
  turnsFromHistory,
  type Turn,
} from "../src/features/coding/turns.ts";

function mixedTurn(): Turn {
  let turn = newTurn("execution", "检查执行状态", 1000);
  for (const callId of ["done", "failed", "pending"])
    turn = applyTurnEvent(turn, {
      type: "tool",
      phase: "start",
      callId,
      name: "bash",
      detail: `${callId} command`,
    });
  turn = applyTurnEvent(turn, {
    type: "tool",
    phase: "end",
    callId: "done",
    ok: true,
  });
  return applyTurnEvent(turn, {
    type: "tool",
    phase: "end",
    callId: "failed",
    ok: false,
  });
}

for (const status of ["complete", "stopped", "error"] as const) {
  test(`${status} settles pending tools without changing recorded outcomes`, () => {
    const live = mixedTurn();
    const finished = finishTurn(live, status, 5000, "failure detail");
    assert.equal(finished.status, status);
    assert.equal(finished.endedAt, 5000);
    assert.equal(finished.error, "failure detail");
    assert.deepEqual(
      finished.tools.map((tool) => tool.state),
      ["ok", "failed", status === "error" ? "failed" : "stopped"],
    );
    assert.equal(live.tools[2]!.state, "running", "do not mutate live state");
    assert.deepEqual(finishTurn(finished, status, 5000), finished);
  });
}

test("stopping a command does not count as a failed command in the recap", () => {
  const stopped = finishTurn(mixedTurn(), "stopped", 5000);
  const summary = summarizeTurn(stopped, () => ({ added: 0, removed: 0 }));
  assert.deepEqual(summary.commands, [
    { command: "done command", ok: true },
    { command: "failed command", ok: false },
  ]);
  assert.equal(summary.failedSteps, 0);
});

test("a completed stream with a missing tool result never fabricates success", () => {
  const finished = finishTurn(mixedTurn(), "complete", 5000);
  assert.equal(finished.tools[2]!.state, "stopped");
  const [replayed] = turnsFromHistory("execution", [
    {
      prompt: "检查执行状态",
      startedAt: 1000,
      endedAt: 5000,
      status: "complete",
      events: [
        {
          type: "tool",
          phase: "start",
          callId: "pending",
          name: "bash",
        },
      ],
    },
  ]);
  assert.equal(replayed!.tools[0]!.state, finished.tools[2]!.state);
});

test("a turn without tools still retains its completion status and duration", () => {
  const finished = finishTurn(newTurn("text", "你好", 1000), "complete", 6000);
  assert.equal(finished.status, "complete");
  assert.equal(finished.endedAt! - finished.startedAt, 5000);
  assert.deepEqual(finished.tools, []);
});
