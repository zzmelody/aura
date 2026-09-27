import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowCanRenderFields,
  workflowEnumArrayOptions,
  workflowFieldKind,
  workflowFieldLabel,
  workflowFieldPlaceholder,
  workflowOptionLabel,
} from "../src/workflowInputModel.ts";

test("workflow input fields infer useful controls from schema names and metadata", () => {
  assert.equal(workflowFieldKind("prompt", { type: "string" }), "long-text");
  assert.equal(workflowFieldKind("imagePath", { type: "string" }), "image");
  assert.equal(
    workflowFieldKind("firstFrameAssetId", { type: "string" }),
    "image-asset",
  );
  assert.equal(
    workflowFieldKind("firstFramePrompt", { type: "string", maxLength: 1000 }),
    "long-text",
  );
  assert.equal(
    workflowFieldKind("referenceFile", {
      type: "string",
      description: "选择一张参考图片",
    }),
    "image",
  );
  assert.equal(
    workflowFieldKind("outputDirectory", { type: "string" }),
    "directory",
  );
  assert.equal(
    workflowFieldKind("destination", {
      type: "string",
      format: "directory-path",
    }),
    "directory",
  );
  assert.equal(
    workflowFieldKind("imageQuality", {
      type: "string",
      enum: ["low", "high"],
    }),
    "select",
  );
  assert.equal(workflowFieldKind("assetName", { type: "string" }), "text");
  const actions = {
    type: "array",
    items: { type: "string", enum: ["idle", "walk"] },
  };
  assert.equal(workflowFieldKind("requiredActions", actions), "multi-select");
  assert.deepEqual(workflowEnumArrayOptions(actions), ["idle", "walk"]);
  assert.equal(
    workflowCanRenderFields({
      prompt: { type: "string" },
      requiredActions: actions,
    }),
    true,
  );
  assert.equal(
    workflowCanRenderFields({
      referenceImages: { type: "array", items: { type: "string" } },
    }),
    false,
  );
});

test("workflow input fields provide readable localized copy", () => {
  assert.equal(workflowFieldLabel("referenceImagePath", {}), "参考图片");
  assert.equal(workflowFieldLabel("firstFrameAssetId", {}), "首帧参考图");
  assert.equal(workflowFieldLabel("customValue", {}), "Custom Value");
  assert.equal(
    workflowFieldLabel("ignored", { title: "自定义标题" }),
    "自定义标题",
  );
  assert.equal(workflowOptionLabel("xhigh"), "超高");
  assert.equal(workflowOptionLabel("quadruped"), "四足");
  assert.equal(workflowOptionLabel("walk"), "行走");
  assert.equal(
    workflowFieldPlaceholder("outputDirectory", "directory", {}),
    "粘贴 Aura 服务端可访问的目录路径",
  );
  assert.equal(
    workflowFieldPlaceholder("outputDirectory", "directory", {}, true),
    "选择目录，或粘贴路径",
  );
  assert.equal(
    workflowFieldPlaceholder(
      "imagePath",
      "image",
      { description: "可选的参考图片" },
      false,
    ),
    "粘贴 Aura 服务端可访问的图片路径",
  );
});
