import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMessages } from "@aura/protocol";

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
