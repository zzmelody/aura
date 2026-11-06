import assert from "node:assert/strict";
import test from "node:test";
import {
  flowErrorBody,
  FlowError,
  readErrorDetails,
} from "@aura/protocol/errors";
import { agentFailure } from "../src/agent-failure.ts";
import { agentConfig, agentDefaults } from "../src/model-config.ts";

test("model failures expose safe display descriptors without forwarding provider diagnostics or changing legacy statuses", () => {
  for (const [message, status, details] of [
    ["model_output_limit", 400, { code: "model_output_limit" }],
    [
      "budget_exceeded private-response",
      402,
      { code: "model_budget_exceeded" },
    ],
    [
      "OAuth refresh failed for openai-codex private-response",
      400,
      { code: "codex_refresh_failed" },
    ],
    [
      "OpenAI Codex token refresh private-response",
      400,
      { code: "codex_refresh_failed" },
    ],
    [
      "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account private-response",
      422,
      { code: "model_codex_unsupported", params: { model: "gpt-5.4-mini" } },
    ],
    [
      "HTTP 429 private-response",
      400,
      { code: "model_http_failed", params: { status: 429 } },
    ],
    ["HTTP 999 private-response", 400, { code: "model_execution_failed" }],
    ["private-response", 400, { code: "model_execution_failed" }],
  ] as const) {
    const error = agentFailure(message);
    assert.ok(error instanceof FlowError);
    assert.equal(error.status, status);
    assert.deepEqual(readErrorDetails(flowErrorBody(error)), details);
    assert.equal(
      JSON.stringify(flowErrorBody(error)).includes("private-response"),
      false,
    );
    assert.equal(error.cause, undefined);
  }
  assert.throws(
    () => agentDefaults("custom"),
    (error) => {
      assert.ok(error instanceof FlowError);
      assert.equal(error.message, "自定义模型尚未配置。");
      assert.deepEqual(readErrorDetails(flowErrorBody(error)), {
        code: "custom_model_unconfigured",
      });
      return true;
    },
  );
  assert.throws(
    () => agentConfig(agentDefaults("codex"), { maxTokens: 128 }),
    (error) => {
      assert.ok(error instanceof FlowError);
      assert.equal(error.status, 422);
      assert.match(error.message, /^AGENT_OPTION_UNSUPPORTED:/u);
      assert.deepEqual(readErrorDetails(flowErrorBody(error)), {
        code: "codex_max_tokens_unsupported",
      });
      return true;
    },
  );
});
