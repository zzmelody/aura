import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@aura/core/types";
import {
  flowConversationHistory,
  flowConversationPrompt,
} from "../src/flow-conversation.ts";

test("a conversation execution request retains the selected flow, structured input and mode", () => {
  const input = { text: '中文\nquoted "input"', count: 0, enabled: false };
  const prompt = flowConversationPrompt(
    { id: "studio/report", title: "报告" },
    input,
    "custom",
  );
  assert.match(prompt, /studio\/report/u);
  assert.match(prompt, /运行模式：custom/u);
  assert.deepEqual(JSON.parse(prompt.split("输入：\n")[1]!), input);
});

test("continuing a historical flow conversation preserves running references and original inputs without changing the record", () => {
  const session: Session = {
    id: "old-flow",
    title: "报告",
    updatedAt: 1,
    workflow: {
      id: "studio/report",
      title: "报告",
      endpoint: "http://localhost:4311",
    },
    messages: [
      {
        id: "run-1:input",
        role: "user",
        text: '{"topic":"Aura"}',
        status: "complete",
      },
      {
        id: "run-1:output",
        role: "assistant",
        text: "正在运行",
        status: "streaming",
        workflowRunId: "run-1",
        workflowPhase: "running",
      },
    ],
  };
  const before = structuredClone(session);
  const history = flowConversationHistory(session);
  assert.equal(history[0]?.text, session.messages[0]?.text);
  assert.match(history[1]!.text, /报告[\s\S]*run-1[\s\S]*不要自动重新执行/u);
  assert.deepEqual(session, before);
});

test("historical flow context is bounded while the latest original Run remains addressable", () => {
  const session: Session = {
    id: "large-flow",
    title: "报告",
    updatedAt: 1,
    messages: Array.from({ length: 30 }, (_, index) => ({
      id: `run-${index}:output`,
      role: "assistant",
      status: "complete",
      text: "长报告".repeat(20_000),
      workflowRunId: `run-${index}`,
    })),
  };
  const history = flowConversationHistory(session);
  assert.equal(history.length, 12);
  assert.match(history.at(-1)!.text, /运行 ID：run-29/u);
  assert.match(history.at(-1)!.text, /摘要已截断/u);
  assert.ok(new TextEncoder().encode(JSON.stringify(history)).length < 55_000);
});
