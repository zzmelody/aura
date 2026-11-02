import assert from "node:assert/strict";
import { test } from "node:test";
import { steerCodingTurn } from "../src/features/coding/api.ts";

test("guidance sends the captured model and effort together with its content", async (t) => {
  const requests: Array<{ url: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ steered: true });
  });
  const modelConfig = {
    mode: "codex" as const,
    selection: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  };
  assert.deepEqual(
    await steerCodingTurn(
      "http://fixture",
      "coding-1",
      "继续检查",
      undefined,
      modelConfig,
    ),
    { steered: true },
  );
  assert.deepEqual(requests, [
    {
      url: "http://fixture/coding/sessions/coding-1/steer",
      body: { prompt: "继续检查", modelConfig },
    },
  ]);
});

test("a rejected guidance request is sent once and reports the failure", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ message: "模型配置不可用" }, { status: 422 });
  });
  await assert.rejects(
    steerCodingTurn("http://fixture", "coding-1", "继续"),
    /模型配置不可用/u,
  );
  assert.equal(requests, 1);
});
