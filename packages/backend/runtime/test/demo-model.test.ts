import { test } from "node:test";
import assert from "node:assert/strict";
import { startDemoModel } from "../src/demo-model.ts";

test("demo model accepts Aura history through its private OpenAI-compatible route", async (t) => {
  const model = await startDemoModel();
  t.after(() => model.close());

  const messages = [{ role: "user", text: "帮我整理今天的安排" }];
  const response = await fetch(`${model.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: `AURA_HISTORY_V1\n${JSON.stringify({ messages })}`,
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /data: \[DONE\]/);
  assert.match(body, /choices/);
});

test("demo model accepts an ordinary Flow agent prompt", async (t) => {
  const model = await startDemoModel();
  t.after(() => model.close());

  const response = await fetch(`${model.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: "请审阅文本：123",
        },
        {
          role: "user",
          content: "Current runtime context.\n\nApproval policy: ask.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "text-stats",
            description: "统计文本",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /已处理以下任务/);
  assert.match(body, /请审阅文本：123/);
  assert.doesNotMatch(body, /Current runtime context/);
});
