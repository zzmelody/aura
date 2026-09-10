import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecord } from "@aura/runtime/validation";

test("record guard accepts only non-null, non-array objects", () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("value"), false);
});
