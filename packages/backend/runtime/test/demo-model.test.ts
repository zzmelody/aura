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
