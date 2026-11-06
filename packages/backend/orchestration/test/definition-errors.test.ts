import assert from "node:assert/strict";
import test from "node:test";
import { CodedFlowError, FlowError } from "@aura/protocol/errors";
import { ActionRegistry } from "../src/action-registry.ts";
import { FlowRegistry } from "../src/registry.ts";
import { validateFlowSource } from "../src/flow-diagnostics.ts";

test("Flow source diagnostics retain line and operation without executing source", () => {
  for (const [source, details, message] of [
    [
      "export default {run(ctx) {\n return Promise.all([]); }};",
      { code: "flow_source_promise", params: { line: 2, method: "all" } },
      /第 2 行.*Promise\.all/u,
    ],
    [
      "export default {run(context) {\n return context.agent({}); }};",
      {
        code: "flow_source_root",
        params: { line: 2, context: "context", operation: "agent" },
      },
      /第 2 行.*根 context/u,
    ],
  ] as const)
    assert.throws(
      () => validateFlowSource(source),
      (error) => {
        assert.ok(error instanceof CodedFlowError);
        assert.equal(error.status, 400);
        assert.match(error.message, message);
        assert.deepEqual(error.details, details);
        return true;
      },
    );
  assert.doesNotThrow(() =>
    validateFlowSource("export default {run(ctx) {return ctx.agent({});}};", {
      allowRootOperations: true,
    }),
  );
});

test("catalog display metadata stays out of execution catalogs and cannot survive cleared or custom problems", () => {
  for (const registry of [new FlowRegistry(), new ActionRegistry()]) {
    registry.problem("fixture", "original diagnostic", {
      code: "flow_source_promise",
      params: { line: 7, method: "race" },
    });
    const raw = registry.catalog();
    const projected = registry.displayCatalog();
    assert.equal(raw[0]!.error, "original diagnostic");
    assert.equal(raw[0]!.errorDetails, undefined);
    assert.deepEqual(projected[0]!.errorDetails, {
      code: "flow_source_promise",
      params: { line: 7, method: "race" },
    });
    assert.throws(
      () => registry.get("fixture"),
      (error) => {
        assert.ok(error instanceof CodedFlowError);
        assert.equal(error.status, 422);
        assert.equal(error.message, "original diagnostic");
        return true;
      },
    );
    projected[0]!.errorDetails = { code: "service_closing" };
    assert.notEqual(
      registry.displayCatalog()[0]!.errorDetails!.code,
      "service_closing",
    );
    registry.problem("fixture", "Custom plugin advice");
    assert.equal(registry.displayCatalog()[0]!.errorDetails, undefined);
    assert.throws(
      () => registry.get("fixture"),
      (error) => {
        assert.ok(error instanceof FlowError);
        assert.equal(error instanceof CodedFlowError, false);
        assert.equal(error.message, "Custom plugin advice");
        return true;
      },
    );
    registry.clearProblem("fixture");
    assert.equal(registry.displayCatalog().length, 0);
    assert.throws(
      () => registry.get("fixture"),
      (error) => {
        assert.ok(error instanceof CodedFlowError);
        assert.equal(error.status, 404);
        assert.equal(
          error.details.code,
          registry instanceof FlowRegistry ? "flow_missing" : "action_missing",
        );
        return true;
      },
    );
  }
});
