import type { JsonValue } from "@aura/protocol/types";

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

const labels: Record<string, string> = {
  assetName: "资源名称",
  firstFrameAssetId: "首帧参考图",
  firstFramePrompt: "首帧图片提示词",
  faceLimit: "面数上限",
  imageModel: "图像模型",
  imagePath: "输入图片",
  imageQuality: "图像质量",
  lastFrameAssetId: "末帧参考图",
  lastFramePrompt: "末帧图片提示词",
  narration: "旁白",
  outputDirectory: "输出目录",
  prompt: "生成描述",
  referenceImagePath: "参考图片",
  task: "任务描述",
  visualPrompt: "视频画面与运动提示词",
};

const optionLabels: Record<string, string> = {
  attack: "攻击",
  high: "高",
  humanoid: "人形",
  idle: "待机",
  interact: "交互",
  jump: "跳跃",
  low: "低",
  max: "最高",
  medium: "中",
  quadruped: "四足",
  run: "奔跑",
  sit: "坐下",
  sleep: "睡眠",
  xhigh: "超高",
  walk: "行走",
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

export function workflowFieldLabel(key: string, spec: SchemaObject): string {
  if (typeof spec.title === "string" && spec.title.trim()) return spec.title;
  if (labels[key]) return labels[key];
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
): string {
  if (kind === "image-asset") return "上传图片，或粘贴已有的图片资产 ID";
  if (kind === "image")
    return nativePathPicker
      ? "选择图片，或粘贴路径"
      : "粘贴 Aura 服务端可访问的图片路径";
  if (kind === "directory")
    return nativePathPicker
      ? "选择目录，或粘贴路径"
      : "粘贴 Aura 服务端可访问的目录路径";
  if (typeof spec.description === "string" && spec.description.trim())
    return spec.description;
  if (key === "assetName") return "例如 observatory-robot";
  if (kind === "long-text") return "描述希望工作流完成的任务…";
  return `输入${workflowFieldLabel(key, spec)}`;
}

export function workflowOptionLabel(value: JsonValue): string {
  return typeof value === "string"
    ? (optionLabels[value] ?? value)
    : String(value);
}
