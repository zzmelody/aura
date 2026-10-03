import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowCatalogEntry } from "@aura/protocol/types";
import { filterFlows, prefillFlowInput, slashQuery } from "../src/flowPicker.ts";

const flow = (id: string, title: string, available = true) =>
  ({ id, title, description: `${title} 说明`, available }) as FlowCatalogEntry;

test("picker matches title, description or ID and lists runnable flows first", () => {
  const flows = [
    flow("action-example", "Action 示例", false),
    flow("short-video", "短视频旁白合成"),
    flow("content-plan", "内容计划"),
  ];
  assert.deepEqual(
    filterFlows(flows, "").map((item) => item.id),
    ["short-video", "content-plan", "action-example"],
  );
  assert.deepEqual(
    filterFlows(flows, "VIDEO").map((item) => item.id),
    ["short-video"],
  );
  assert.deepEqual(
    filterFlows(flows, "说明").length,
    3,
  );
});

test("only a leading slash token opens the inline picker", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/短视频"), "短视频");
  assert.equal(slashQuery("/a b"), undefined);
  assert.equal(slashQuery("hello /x"), undefined);
});

test("typed chat text seeds the first free-text field", () => {
  const schema = {
    type: "object",
    properties: {
      voice: { type: "string", enum: ["a", "b"] },
      narration: { type: "string" },
      seconds: { type: "number" },
    },
  };
  assert.deepEqual(
    prefillFlowInput({ voice: "a", narration: "", seconds: 0 }, schema, " 讲一段 "),
    { voice: "a", narration: "讲一段", seconds: 0 },
  );
  assert.deepEqual(prefillFlowInput({ x: "" }, schema, "   "), { x: "" });
  assert.equal(prefillFlowInput("", undefined, "text"), "");
});
