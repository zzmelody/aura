import assert from "node:assert/strict";
import test from "node:test";
import {
  readErrorDetails,
  validationParameters,
  readValidationParameters,
} from "../src/errors.ts";

test("validation details preserve bounded field diagnostics and discard values, messages and unknown reasons", () => {
  const source = [
    {
      code: "invalid_type",
      path: ["字段", 2, "name"],
      expected: "string",
      input: "private-value",
      message: "private-message",
    },
    { code: "too_small", path: ["count"], minimum: 2, input: 0 },
  ];
  const before = JSON.stringify(source);
  const params = validationParameters(source, "flow_input");
  assert.deepEqual(params, {
    target: "flow_input",
    issues: [
      { path: "字段.2.name", reason: "invalid_type", expected: "string" },
      { path: "count", reason: "too_small", limit: 2 },
    ],
    remaining: 0,
  });
  assert.equal(JSON.stringify(params).includes("private"), false);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(
    validationParameters([
      { code: "too_small", path: ["value"], minimum: 2, inclusive: false },
    ])?.issues[0],
    { path: "value", reason: "too_small", limit: 2, inclusive: false },
  );
  assert.deepEqual(readErrorDetails({ code: "validation_failed", params }), {
    code: "validation_failed",
    params,
  });
  for (const code of ["custom", "future_reason"])
    assert.equal(
      validationParameters([
        { code, path: [], message: "original custom guidance" },
      ]),
      undefined,
    );
  assert.equal(
    validationParameters([
      {
        code: "invalid_type",
        path: ["https://private.invalid"],
        expected: "string",
      },
    ]),
    undefined,
  );
  const many = validationParameters(
    Array.from({ length: 40 }, () => source[0]),
  );
  assert.equal(many?.issues.length, 32);
  assert.equal(many?.remaining, 8);
  assert.equal(
    validationParameters([
      ...Array(32).fill(source[0]),
      { code: "custom", path: [], message: "Original guidance" },
    ]),
    undefined,
  );
  for (const value of [
    null,
    {},
    { ...params, target: "private" },
    { ...params, issues: [] },
    { ...params, remaining: -1 },
    { ...params, issues: Array(33).fill(params!.issues[0]) },
  ])
    assert.equal(readValidationParameters(value), undefined);
  assert.deepEqual(
    readErrorDetails({
      code: "json_too_large",
      params: { target: "flow_input", limitBytes: 256, token: "private" },
    }),
    {
      code: "json_too_large",
      params: { target: "flow_input", limitBytes: 256 },
    },
  );
  for (const limitBytes of ["256", 0, -1, 1.5, Infinity, 1e13])
    assert.equal(
      readErrorDetails({
        code: "json_too_large",
        params: { target: "flow_input", limitBytes },
      }),
      undefined,
    );
});
