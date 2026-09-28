import assert from "node:assert/strict";
import test from "node:test";
import { agentFailure } from "../src/sessions.ts";

test("OAuth refresh failures give safe recovery guidance", () => {
  const error = agentFailure(
    "OAuth refresh failed for openai-codex: invalid JSON \u001b secret-token",
  );
  assert.match(error.message, /Codex 登录续期失败/);
  assert.match(error.message, /重新登录 Codex/);
  assert.doesNotMatch(error.message, /secret-token|\u001b/);
});

test("other provider failures retain the generic safe message", () => {
  assert.match(agentFailure("HTTP 429: private-response").message, /HTTP 429/);
  assert.doesNotMatch(agentFailure("HTTP 429: private-response").message, /private-response/);
});
