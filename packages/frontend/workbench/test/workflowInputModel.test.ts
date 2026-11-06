import assert from "node:assert/strict";
import test from "node:test";
import { language } from "@aura/i18n/runtime";
import type { WorkflowTranslate } from "../src/workflow-messages.ts";
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
  const t: WorkflowTranslate = language.i18n.getFixedT("zh-CN", "workflow");
  assert.equal(workflowFieldLabel("referenceImagePath", {}, t), "参考图片");
  assert.equal(workflowFieldLabel("firstFrameAssetId", {}, t), "首帧参考图");
  assert.equal(workflowFieldLabel("customValue", {}, t), "Custom Value");
  assert.equal(
    workflowFieldLabel("ignored", { title: "自定义标题" }, t),
    "自定义标题",
  );
  assert.equal(workflowOptionLabel("xhigh", t), "超高");
  assert.equal(workflowOptionLabel("quadruped", t), "四足");
  assert.equal(workflowOptionLabel("walk", t), "行走");
  assert.equal(
    workflowFieldPlaceholder("outputDirectory", "directory", {}, false, t),
    "粘贴 Aura 服务端可访问的目录路径",
  );
  assert.equal(
    workflowFieldPlaceholder("outputDirectory", "directory", {}, true, t),
    "选择目录，或粘贴路径",
  );
  assert.equal(
    workflowFieldPlaceholder(
      "imagePath",
      "image",
      { description: "可选的参考图片" },
      false,
      t,
    ),
    "粘贴 Aura 服务端可访问的图片路径",
  );
});

test("six-language field projections keep schema data, custom metadata and option values intact", () => {
  const spec = {
    type: "string",
    title: "自定义标题 / Custom title",
    description: "User supplied hint",
    enum: ["low", "custom-choice"],
  };
  const original = structuredClone(spec);
  const labels = new Set<string>();
  const hints = new Set<string>();
  const options: Record<string, string> = {
    "zh-CN": "四足",
    en: "Quadruped",
    ja: "四足",
    ko: "네 발",
    ru: "Четвероногое",
    fr: "Quadrupède",
  };
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
    const t: WorkflowTranslate = language.i18n.getFixedT(locale, "workflow");
    labels.add(workflowFieldLabel("referenceImagePath", {}, t));
    hints.add(workflowFieldPlaceholder("imagePath", "image", {}, false, t));
    assert.equal(workflowOptionLabel("quadruped", t), options[locale]);
    assert.equal(workflowFieldLabel("referenceImagePath", spec, t), spec.title);
    assert.equal(
      workflowFieldPlaceholder("custom", "text", spec, false, t),
      spec.description,
    );
    assert.equal(workflowOptionLabel("custom-choice", t), "custom-choice");
    assert.equal(workflowFieldKind("imagePath", spec), "select");
  }
  assert.equal(labels.size, 6);
  assert.equal(hints.size, 6);
  assert.deepEqual(spec, original);
});
