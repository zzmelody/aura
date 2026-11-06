import assert from "node:assert/strict";
import test from "node:test";
import { readErrorDetails } from "../src/errors.ts";

test("diagnostic projections retain public locations and identifiers while rejecting paths and arbitrary reasons", () => {
  for (const [code, params] of [
    ["flow_step_duplicate", { id: "plugin/flow/step" }],
    ["flow_depth_limit", { limit: 8 }],
    ["flow_source_promise", { line: 12, method: "allSettled" }],
    ["flow_source_root", { line: 4, context: "ctx", operation: "checkpoint" }],
    [
      "flow_model_config_unavailable",
      {
        reason: "UNKNOWN_MODEL",
        provider: "openai",
        model: "fixture-1",
        effort: "medium",
      },
    ],
    [
      "action_execution_failed",
      { id: "sample/action", reason: "TOOL_TIMEOUT" },
    ],
    ["flow_cycle", { ids: ["one", "two", "one"] }],
    ["conversation_tools_missing", { tools: ["read_file", "write_file"] }],
  ] as const) {
    assert.deepEqual(
      readErrorDetails({
        code,
        params: { ...params, token: "private", diagnostic: "private" },
        cause: "private",
      }),
      { code, params },
    );
  }
  for (const params of [
    { id: "C:/private" },
    { id: "/private" },
    { id: "a/../private" },
    { id: "{{secret}}" },
    { id: "x".repeat(513) },
  ])
    assert.equal(
      readErrorDetails({ code: "flow_step_duplicate", params }),
      undefined,
    );
  for (const params of [
    { line: 0, method: "all" },
    { line: 2, method: "private" },
    { line: 1.5, method: "any" },
  ])
    assert.equal(
      readErrorDetails({ code: "flow_source_promise", params }),
      undefined,
    );
  assert.equal(
    readErrorDetails({
      code: "flow_cycle",
      params: { ids: Array(11).fill("flow") },
    }),
    undefined,
  );
  assert.equal(
    readErrorDetails({
      code: "conversation_tools_missing",
      params: { tools: ["read_file", "https://private"] },
    }),
    undefined,
  );
  const source = { code: "flow_cycle", params: { ids: ["a", "b"] } };
  const safe = readErrorDetails(source);
  source.params.ids.push("private");
  assert.deepEqual(safe, { code: "flow_cycle", params: { ids: ["a", "b"] } });
});
