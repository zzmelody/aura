import assert from "node:assert/strict";
import test from "node:test";
import { agentFailure } from "../src/sessions.ts";

test("known max-token endings are distinct from transport or execution failures",()=>{
  assert.match(agentFailure("model_output_limit").message,/^model_output_limit:/u);
  assert.match(agentFailure("model_output_limit").message,/输出上限/u);
});

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

test("provider budget exhaustion gives safe actionable guidance", () => {
  for (const message of ['400 {"error":{"type":"budget_exceeded","message":"private provider response"}}',
    "Budget has been exceeded! Current cost: 335.41187154427206, Max budget: 300.0 secret-token"]) {
    const error = agentFailure(message);
    assert.equal(error.status, 402);
    assert.match(error.message, /^model_budget_exceeded:/u);
    assert.match(error.message, /额度已用尽/u);
    assert.doesNotMatch(error.message, /private|secret|335|300/u);
  }
});
