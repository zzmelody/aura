import { defineAction } from "@aura/orchestration/action";
import { localAI } from "@aura/orchestration/local-ai";

export default defineAction({
  title: "ComfyUI 工作流执行",
  description:
    "在本地图片或视频 ComfyUI 上执行自定义 API 格式 workflow，支持 JSON 对象或本地文件、节点入参覆盖，返回动态输出和产物路径。自动启停及回收进程；不是 Aura Flow，也不转换界面画布 JSON。",
  parameters: {
    service: {
      type: "string",
      enum: ["qwen-image", "minimax-h3"],
      required: true,
    },
    workflow: {
      type: "object",
      additionalProperties: true,
      description:
        "ComfyUI API 节点图或 {prompt: 节点图}；与 workflowFile 二选一。",
    },
    workflowFile: {
      type: "string",
      description:
        "API JSON 文件路径，绝对路径或相对 Aura 后端工作区；每次调用重新读取，最多 256 KiB。",
    },
    overrides: {
      type: "object",
      additionalProperties: true,
      description:
        '节点输入覆盖，例如 {"6":{"text":"新提示词"},"8":{"seed":42}}；节点和输入必须已存在。',
    },
    imageBindings: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      description:
        '受管图片绑定，例如 [{"nodeId":"16","assetId":"64位SHA-256"}]；目标必须为已有 LoadImage.image 节点。',
    },
    outputNodeIds: {
      type: "array",
      items: { type: "string" },
      description:
        "只返回指定节点的 UI 输出，省略则返回全部；不改变 workflow 执行范围。",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string", required: true },
        promptId: { type: "string", required: true },
        workflowHash: { type: "string", required: true },
        files: { type: "array", items: { type: "string" }, required: true },
        outputs: { type: "object", additionalProperties: true, required: true },
      },
    },
    render: (_input, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  timeoutMs: 600_000,
  isConcurrencySafe: () => true,
  async execute(ctx, input) {
    // DSH's open-object DSL cannot express the nested node-id -> inputs map.
    // The backend validates its JSON values and exact shape before starting ComfyUI.
    const { overrides, imageBindings, ...rest } = input;
    return localAI(ctx).comfyWorkflow(
      {
        ...rest,
        ...(overrides === undefined
          ? {}
          : {
              overrides:
                /** @type {NonNullable<import("@aura/orchestration/local-ai").ComfyWorkflowInput["overrides"]>} */ (
                  overrides
                ),
            }),
        ...(imageBindings === undefined
          ? {}
          : {
              imageBindings:
                /** @type {NonNullable<import("@aura/orchestration/local-ai").ComfyWorkflowInput["imageBindings"]>} */ (
                  imageBindings
                ),
            }),
      },
      ctx.signal,
    );
  },
});
