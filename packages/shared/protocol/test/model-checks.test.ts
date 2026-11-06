import assert from "node:assert/strict";
import test from "node:test";
import { readModelServiceCheck } from "../src/model-checks.ts";

test("model check details expose only bounded display fields and reject unknown outcomes", () => {
  const success = {
    code: "probe_succeeded",
    model: "original-model",
    elapsedMs: 1250,
    reply: "OK",
  };
  assert.deepEqual(
    readModelServiceCheck({
      ...success,
      token: "private",
      cause: { response: "private" },
    }),
    success,
  );
  assert.deepEqual(
    readModelServiceCheck({
      code: "probe_failed",
      model: "original-model",
      reason: "authentication",
      message: "private",
    }),
    { code: "probe_failed", model: "original-model", reason: "authentication" },
  );
  assert.deepEqual(readModelServiceCheck({ code: "models_synced", count: 0 }), {
    code: "models_synced",
    count: 0,
  });
  for (const value of [
    null,
    [],
    "OK",
    { code: "future" },
    { ...success, elapsedMs: -1 },
    { ...success, elapsedMs: Infinity },
    { ...success, reply: "x".repeat(81) },
    { ...success, model: "x".repeat(1001) },
    { code: "probe_failed", model: "model", reason: "raw upstream error" },
    { code: "models_listed", count: 1.5 },
    { code: "models_listed", count: 1_000_001 },
  ])
    assert.equal(readModelServiceCheck(value), undefined);
});
