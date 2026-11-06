import type { JsonValue } from "@aura/protocol/types";
import {
  workflowText,
  type WorkflowTranslate,
  type WorkflowMessageKey,
} from "./workflow-messages.ts";

export type WorkflowFieldKind =
  | "boolean"
  | "directory"
  | "image"
  | "image-asset"
  | "long-text"
  | "multi-select"
  | "number"
  | "select"
  | "text";

type SchemaObject = Record<string, JsonValue>;

const labels: Record<string, WorkflowMessageKey> = {
  assetName: "fieldAssetName",
  firstFrameAssetId: "fieldFirstFrameAsset",
  firstFramePrompt: "fieldFirstFramePrompt",
  faceLimit: "fieldFaceLimit",
  imageModel: "fieldImageModel",
  imagePath: "fieldImagePath",
  imageQuality: "fieldImageQuality",
  lastFrameAssetId: "fieldLastFrameAsset",
  lastFramePrompt: "fieldLastFramePrompt",
  narration: "fieldNarration",
  outputDirectory: "fieldOutputDirectory",
  prompt: "fieldPrompt",
  referenceImagePath: "fieldReferenceImage",
  task: "fieldTask",
  visualPrompt: "fieldVisualPrompt",
};

const optionLabels: Record<string, WorkflowMessageKey> = {
  attack: "optionAttack",
  high: "optionHigh",
  humanoid: "optionHumanoid",
  idle: "optionIdle",
  interact: "optionInteract",
  jump: "optionJump",
  low: "optionLow",
  max: "optionMax",
  medium: "optionMedium",
  quadruped: "optionQuadruped",
  run: "optionRun",
  sit: "optionSit",
  sleep: "optionSleep",
  xhigh: "optionXhigh",
  walk: "optionWalk",
};

export function workflowEnumArrayOptions(
  spec: SchemaObject,
): JsonValue[] | null {
  if (spec.type !== "array") return null;
  const items = spec.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) return null;
  if (items.type !== "string" || !Array.isArray(items.enum)) return null;
  if (!items.enum.every((value) => typeof value === "string")) return null;
  return items.enum;
}

export function workflowCanRenderFields(properties: SchemaObject): boolean {
  return Object.values(properties).every((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field))
      return false;
    return (
      ["string", "number", "integer", "boolean"].includes(String(field.type)) ||
      workflowEnumArrayOptions(field) !== null
    );
  });
}

export function workflowFieldKind(
  key: string,
  spec: SchemaObject,
): WorkflowFieldKind {
  if (workflowEnumArrayOptions(spec)) return "multi-select";
  if (Array.isArray(spec.enum)) return "select";
  if (spec.type === "boolean") return "boolean";
  if (spec.type === "number" || spec.type === "integer") return "number";

  const explicit = spec["x-aura-control"] ?? spec.format;
  if (explicit === "image-asset") return "image-asset";
  if (explicit === "image" || explicit === "image-path") return "image";
  if (explicit === "directory" || explicit === "directory-path")
    return "directory";

  const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
  if (/(?:image|frame)assetid$/u.test(normalized)) return "image-asset";
  const description =
    typeof spec.description === "string" ? spec.description.toLowerCase() : "";
  if (
    /^(?:prompt|task|instruction|instructions|message|content|query|description)$/u.test(
      normalized,
    ) ||
    (typeof spec.maxLength === "number" && spec.maxLength > 500)
  )
    return "long-text";
  if (
    /(?:image|photo|picture|thumbnail).*(?:path|file)|(?:path|file).*(?:image|photo|picture|thumbnail)/u.test(
      normalized,
    ) ||
    /(?:选择|上传).*(?:图片|图像)|(?:图片|图像).*(?:路径|文件)/u.test(
      description,
    )
  )
    return "image";
  if (
    /(?:directory|folder|outputdir|targetdir)$/u.test(normalized) ||
    /目录|文件夹/u.test(description)
  )
    return "directory";
  return "text";
}

export function workflowFieldLabel(
  key: string,
  spec: SchemaObject,
  t: WorkflowTranslate = workflowText,
): string {
  if (typeof spec.title === "string" && spec.title.trim()) return spec.title;
  if (labels[key]) return t(labels[key]);
  const spaced = key
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : key;
}

export function workflowFieldPlaceholder(
  key: string,
  kind: WorkflowFieldKind,
  spec: SchemaObject,
  nativePathPicker = false,
  t: WorkflowTranslate = workflowText,
): string {
  if (kind === "image-asset") return t("assetPlaceholder");
  if (kind === "image")
    return nativePathPicker
      ? t("pickImagePlaceholder")
      : t("serverImagePlaceholder");
  if (kind === "directory")
    return nativePathPicker
      ? t("pickDirectoryPlaceholder")
      : t("serverDirectoryPlaceholder");
  if (typeof spec.description === "string" && spec.description.trim())
    return spec.description;
  if (key === "assetName") return t("assetNamePlaceholder");
  if (kind === "long-text") return t("taskPlaceholder");
  return t("enterField", { label: workflowFieldLabel(key, spec, t) });
}

export function workflowOptionLabel(
  value: JsonValue,
  t: WorkflowTranslate = workflowText,
): string {
  return typeof value === "string"
    ? optionLabels[value]
      ? t(optionLabels[value])
      : value
    : String(value);
}
