import assert from "node:assert/strict";
import test from "node:test";
import { parseEventState } from "../action/ange-pi/ange-pi.action.js";

test("ange-pi folds a completed Pi JSONL turn", () => {
  const result = parseEventState([
    { type: "session", id: "00000000-0000-4000-8000-000000000001", cwd: "/tmp/ange" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "toolCall", name: "ange_check_plan" },
          { type: "text", text: "已完成检查。" },
        ],
      },
      usage: { totalTokens: 12 },
    },
    { type: "agent_end", messages: [] },
  ]);
  assert.equal(result.protocolComplete, true);
  assert.equal(result.terminalStatus, "completed");
  assert.equal(result.finalText, "已完成检查。");
  assert.deepEqual(result.toolCalls, ["ange_check_plan"]);
  assert.deepEqual(result.usage, { totalTokens: 12 });
});

test("ange-pi treats an error stop as failed and preserves the provider error", () => {
  const result = parseEventState([
    { type: "session", id: "00000000-0000-4000-8000-000000000002" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider unavailable",
        content: [],
      },
    },
    { type: "agent_end", messages: [] },
  ]);
  assert.equal(result.protocolComplete, true);
  assert.equal(result.terminalStatus, "failed");
  assert.equal(result.terminalError, "provider unavailable");
});

test("ange-pi keeps an incomplete stream incomplete", () => {
  const result = parseEventState([
    { type: "session", id: "00000000-0000-4000-8000-000000000003" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
  ]);
  assert.equal(result.protocolComplete, false);
  assert.equal(result.terminalStatus, "incomplete");
});
