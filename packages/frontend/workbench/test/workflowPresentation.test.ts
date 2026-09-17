import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@aura/core/types";
import {
  hasWorkflowContent,
  storedWorkflowValue,
  workflowDuration,
  workflowExecutions,
  workflowProgress,
} from "../src/workflowPresentation.ts";
import type { FlowRun } from "@aura/protocol/types";

test("execution turns pair input by run identity and retain unrelated history", () => {
  const messages: Message[] = [
    { id: "a:input", role: "user", text: "Input A", status: "complete" },
    { id: "b:input", role: "user", text: "Input B", status: "complete" },
    {
      id: "a:output",
      role: "assistant",
      text: "Output A",
      status: "complete",
      workflowRunId: "a",
    },
    { id: "note", role: "user", text: "An earlier note", status: "complete" },
    {
      id: "b:output",
      role: "assistant",
      text: "Output B",
      status: "streaming",
      workflowRunId: "b",
    },
  ];
  const cards = workflowExecutions(messages);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].input?.text, "Input A");
  assert.equal(cards[1].message.id, "note");
  assert.equal(cards[2].input?.text, "Input B");
  assert.equal(messages.length, 5);
  assert.equal(workflowExecutions([messages[2]])[0].input, undefined);
});

test("empty reports are distinct from valid zero and false results", () => {
  for (const value of [
    undefined,
    null,
    "",
    "  ",
    {},
    [],
    { report: "" },
    { nested: [null, " "] },
  ])
    assert.equal(hasWorkflowContent(value), false);
  for (const value of [
    0,
    false,
    { count: 0 },
    [false],
    { report: "## Result\n- Done" },
  ])
    assert.equal(hasWorkflowContent(value), true);
});

test("saved inputs and outputs preserve structured values and markdown text", () => {
  assert.deepEqual(storedWorkflowValue('{"task":"One","limit":2}'), {
    task: "One",
    limit: 2,
  });
  assert.deepEqual(storedWorkflowValue('[{"title":"A"}]'), [{ title: "A" }]);
  assert.equal(
    storedWorkflowValue("# Result\n\n**Complete**"),
    "# Result\n\n**Complete**",
  );
  assert.equal(storedWorkflowValue("false"), false);
});

test("progress keeps concurrent active steps and does not count failures as completed", () => {
  const run = {
    steps: [
      { label: "Prepare", status: "completed" },
      { label: "Research", status: "running" },
      { label: "Review", status: "running" },
      { label: "Save", status: "failed" },
    ],
  } as FlowRun;
  assert.deepEqual(workflowProgress(run), {
    completed: 1,
    total: 4,
    current: ["Research", "Review"],
  });
  assert.deepEqual(workflowProgress(undefined), {
    completed: 0,
    total: 0,
    current: [],
  });
  assert.equal(workflowDuration(2000, 1000), "0 秒");
  assert.equal(workflowDuration(0, 65000), "1 分 5 秒");
  assert.equal(workflowDuration(0, 3660000), "1 小时 1 分");
});
