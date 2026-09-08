import { test } from "node:test";
import assert from "node:assert/strict";
import { demoReply, streamDemo } from "@aura/demo";

test("offline conversation keeps prior user context", () => {
  assert.match(demoReply([{ role: "user", text: "你好" }]), /无需 API Key/);
  assert.match(
    demoReply([
      { role: "user", text: "新想法" },
      { role: "assistant", text: "好" },
      { role: "user", text: "继续" },
    ]),
    /我们接着聊「新想法」/,
  );
  assert.match(demoReply([{ role: "user", text: "安排今天" }]), /没有创建日程/);
});

test("chunk stream reconstructs reply and supports cancellation", async () => {
  const messages = [{ role: "user", text: "你好" }];
  let output = "";
  for await (const chunk of streamDemo(messages, { delay: 0 })) output += chunk;
  assert.equal(output, demoReply(messages));
  const abort = new AbortController();
  const stream = streamDemo(messages, { signal: abort.signal, delay: 0 });
  assert.ok((await stream.next()).value);
  abort.abort();
  await assert.rejects(stream.next(), { name: "AbortError" });
});
