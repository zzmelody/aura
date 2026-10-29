import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoModelApp, startDemoModel } from "../src/demo-model.ts";
import { conversationPrompt } from "@aura/protocol/conversations";

test("persistent conversation prompts retain demo workflow tool selection", async () => {
  const app = createDemoModelApp();
  for (const content of [
    "帮我配音：你好",
    conversationPrompt("帮我配音：你好", [
      { role: "assistant", text: "旧回复" },
    ]),
  ]) {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content }],
        tools: [
          { type: "function", function: { name: "aura_tts", parameters: {} } },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /aura_tts/);
  }
});

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

test("demo chat model selects offered workflow tools deterministically", async () => {
  const { demoToolCall, demoToolReply } =
    await import("../src/demo-chat-tools.ts");
  const tools = ["aura_tts", "aura_video", "aura_topic_research"].map(
    (name) => ({ type: "function", function: { name, parameters: {} } }),
  );
  const call = (text: string, offered = tools) =>
    demoToolCall({ tools: offered, messages: [] }, [{ role: "user", text }]);
  assert.deepEqual(call("帮我配音：今天下雨了"), {
    name: "aura_tts",
    arguments: { text: "今天下雨了" },
  });
  const video = call("把这个故事做成视频：清晨出发。黄昏归来。");
  assert.equal(video?.name, "aura_video");
  assert.equal((video?.arguments.shots as unknown[]).length, 2);
  assert.equal(call("找几个 AI 游戏的选题")?.name, "aura_topic_research");
  assert.equal(call("今天天气怎么样"), undefined);
  assert.equal(call("帮我配音：你好", []), undefined);
  assert.equal(
    demoToolCall({ tools, messages: [{ role: "tool", content: "{}" }] }, [
      { role: "user", text: "帮我配音：你好" },
    ]),
    undefined,
  );
  assert.match(
    demoToolReply({
      messages: [
        { role: "tool", content: '{"status":"rejected","error":"忙"}' },
      ],
    }),
    /没能启动：忙/u,
  );
});

test("demo model streams an OpenAI tool call when a chat workflow is requested", async (t) => {
  const model = await startDemoModel();
  t.after(() => model.close());
  const messages = [{ role: "user", text: "帮我配音：欢迎来到 Aura" }];
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
      tools: [
        { type: "function", function: { name: "aura_tts", parameters: {} } },
      ],
    }),
  });
  const body = await response.text();
  assert.match(body, /"tool_calls"/);
  assert.match(body, /"finish_reason":"tool_calls"/);
  assert.match(body, /aura_tts/);
});

test("demo chat model maps picture requests to the image tool with an aspect", async () => {
  const { demoToolCall } = await import("../src/demo-chat-tools.ts");
  const tools = [
    { type: "function", function: { name: "aura_image", parameters: {} } },
  ];
  const call = (text: string) =>
    demoToolCall({ tools, messages: [] }, [{ role: "user", text }]);
  assert.deepEqual(call("帮我画一张竖图：雨夜的霓虹街道"), {
    name: "aura_image",
    arguments: { prompt: "雨夜的霓虹街道", aspect: "portrait" },
  });
  assert.equal(call("生成一张图片：山顶日出")?.arguments.aspect, "square");
  assert.equal(call("这张图片好看吗"), undefined);
});
