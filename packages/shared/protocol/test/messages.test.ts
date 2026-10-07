import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMessages, validateChatModelSelection } from "@aura/protocol";

test("chat settings accept bounded opaque DSH IDs but no provider, endpoint or credentials", () => {
  for (const valid of [
    {},
    { model: "gpt-6.1-sol" },
    { reasoningEffort: "xhigh" },
    { model: "m", reasoningEffort: "off" },
  ])
    assert.ok(validateChatModelSelection(valid));
  for (const invalid of [
    null,
    [],
    { model: " " },
    { model: "with\nnewline" },
    { reasoningEffort: 4 },
    { model: "m".repeat(201) },
    { reasoningEffort: "e".repeat(81) },
    { apiKey: "secret" },
    { provider: "p" },
    { baseURL: "https://example.com" },
  ])
    assert.equal(validateChatModelSelection(invalid), false);
});

test("HTTP rejects empty, oversized, non-text and invalid-role messages", () => {
  assert.ok(validateMessages([{ role: "user", text: "hello" }]));
  for (const input of [
    [],
    null,
    [{ role: "system", text: "x" }],
    [{ role: "user", text: " " }],
    [{ role: "user", text: "x".repeat(4001) }],
    [{ role: "assistant", text: "x" }],
    [{ role: "user", text: 3 }],
  ])
    assert.equal(validateMessages(input), false);
});
