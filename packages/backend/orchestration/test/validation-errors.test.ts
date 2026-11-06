import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { CodedFlowError } from "@aura/protocol/errors";
import { parseJson, jsonValue } from "../src/schema.ts";

test("Flow validation keeps legacy messages, all field failures and original inputs without invoking work", () => {
  const schema = z.object({
    task: z.string().min(2),
    count: z.number().max(4),
  });
  const input = { task: "", count: 5 };
  const before = JSON.stringify(input);
  assert.throws(
    () => parseJson(schema, input, "Flow 入参"),
    (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Flow 入参.*task.*count/u);
      assert.equal(error.details.code, "validation_failed");
      if (error.details.code === "validation_failed") {
        assert.equal(error.details.params.target, "flow_input");
        assert.deepEqual(
          error.details.params.issues.map((item) => item.path),
          ["task", "count"],
        );
      }
      return true;
    },
  );
  assert.equal(JSON.stringify(input), before);
  assert.throws(
    () => jsonValue({ n: BigInt(1) }, "Flow 出参"),
    (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.message, "Flow 出参必须是可序列化的 JSON 数据。");
      assert.deepEqual(error.details, {
        code: "json_not_serializable",
        params: { target: "flow_output" },
      });
      return true;
    },
  );
  assert.throws(
    () => jsonValue("large", "Flow 入参", 2),
    (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, 413);
      assert.deepEqual(error.details, {
        code: "json_too_large",
        params: { target: "flow_input", limitBytes: 2 },
      });
      return true;
    },
  );
  assert.throws(
    () =>
      parseJson(
        z.string().refine(() => false, { message: "Original custom guidance" }),
        "text",
        "Custom label",
      ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof CodedFlowError, false);
      assert.match(error.message, /Original custom guidance/u);
      return true;
    },
  );
});
