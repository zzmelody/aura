import assert from "node:assert/strict";
import test from "node:test";
import {
  apiErrorCodes,
  CodedFlowError,
  FlowError,
  flowErrorBody,
  readErrorDetails,
  readFlowFailureDetails,
  PluginFailure,
  readErrorTranslations,
} from "../src/errors.ts";

test("plugin error translations are bounded literal display data and exclude unknown fields and causes", () => {
  const messages = {
    en: "Keep {{literal}} <text>",
    fr: "Texte conservé",
    token: "private",
  };
  assert.deepEqual(readErrorTranslations(messages), {
    en: messages.en,
    fr: messages.fr,
  });
  for (const invalid of [
    { fr: "pas d’anglais" },
    { en: "" },
    { en: "x".repeat(2001) },
    { en: "safe", ja: 42 },
  ])
    assert.equal(readErrorTranslations(invalid), undefined);
  const error = new PluginFailure("old_safe_code", messages, 422);
  error.cause = new Error("private response");
  assert.deepEqual(flowErrorBody(error), {
    message: "old_safe_code",
    code: "plugin_failure",
    params: { translations: { en: messages.en, fr: messages.fr } },
  });
  assert.equal(error.status, 422);
});

test("error metadata allows only known codes and bounded numeric parameters", () => {
  for (const code of apiErrorCodes)
    assert.deepEqual(readErrorDetails({ code, params: { token: "private" } }), {
      code,
    });
  for (const [code, key] of [
    ["image_too_large", "limitMiB"],
    ["flow_request_too_large", "limitKiB"],
  ]) {
    for (const value of [null, "32", -1, 0, 1.5, Infinity, NaN, 1_048_577, {}])
      assert.equal(
        readErrorDetails({ code, params: { [key]: value } }),
        undefined,
      );
    assert.equal(readErrorDetails({ code }), undefined);
    assert.deepEqual(
      readErrorDetails({
        code,
        params: { [key]: 32, token: "private", message: "private" },
        path: "private",
      }),
      { code, params: { [key]: 32 } },
    );
  }
  for (const value of [
    null,
    [],
    "service_closing",
    {},
    { code: "future_code" },
  ])
    assert.equal(readErrorDetails(value), undefined);
});

test("coded errors serialize as additive metadata without changing legacy FlowError behavior", () => {
  const old = new FlowError("existing readable message", 409);
  assert.deepEqual(flowErrorBody(old), {
    message: "existing readable message",
  });
  assert.equal(old.status, 409);
  assert.equal(old.name, "Error");
  const error = new CodedFlowError("existing readable message", 413, {
    code: "image_too_large",
    params: { limitMiB: 32 },
  });
  error.cause = new Error("private upstream response");
  assert.ok("params" in error.details);
  Object.assign(error.details.params, { apiKey: "private" });
  assert.ok(error instanceof FlowError);
  assert.equal(error.status, 413);
  assert.equal(error.name, "Error");
  const body: unknown = JSON.parse(JSON.stringify(flowErrorBody(error)));
  assert.deepEqual(body, {
    message: "existing readable message",
    code: "image_too_large",
    params: { limitMiB: 32 },
  });
  assert.deepEqual(readErrorDetails(body), {
    code: "image_too_large",
    params: { limitMiB: 32 },
  });
});

test("model error parameters allow only bounded identifiers and HTTP status numbers", () => {
  for (const [code, key, value] of [
    ["model_codex_unsupported", "model", "gpt-5.4-mini"],
    ["model_selection_unavailable", "reason", "UNKNOWN_MODEL"],
    ["model_http_failed", "status", 429],
  ] as const) {
    assert.deepEqual(
      readErrorDetails({
        code,
        params: { [key]: value, token: "private", diagnostic: "private" },
      }),
      { code, params: { [key]: value } },
    );
    for (const invalid of [
      null,
      {},
      [],
      "",
      "Bearer private",
      "https://private.invalid",
      "{{private}}",
      "x".repeat(101),
    ])
      assert.equal(
        readErrorDetails({ code, params: { [key]: invalid } }),
        undefined,
      );
  }
  for (const status of ["429", 99, 600, 429.5, Infinity])
    assert.equal(
      readErrorDetails({ code: "model_http_failed", params: { status } }),
      undefined,
    );
  assert.equal(
    readErrorDetails({
      code: "model_selection_unavailable",
      params: { reason: "unknown_model" },
    }),
    undefined,
  );
  assert.equal(
    readErrorDetails({
      code: "model_codex_unsupported",
      params: { model: "m".repeat(81) },
    }),
    undefined,
  );
});

test("Flow display failures project only recognized reasons and uncertainty markers", () => {
  assert.equal(
    readFlowFailureDetails({ failure: { code: "external" }, token: "private" }),
    undefined,
  );
  assert.equal(readFlowFailureDetails(null), undefined);
  assert.deepEqual(
    readFlowFailureDetails({
      failure: {
        code: "model_http_failed",
        params: { status: 429, token: "private" },
      },
      uncertainty: "agent_result_unknown",
      diagnostic: "private",
    }),
    {
      failure: { code: "model_http_failed", params: { status: 429 } },
      uncertainty: "agent_result_unknown",
    },
  );
  assert.deepEqual(
    readFlowFailureDetails({
      failure: { code: "flow_cancelled" },
      uncertainty: "private",
    }),
    { failure: { code: "flow_cancelled" } },
  );
});
