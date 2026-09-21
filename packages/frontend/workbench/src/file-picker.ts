import { platform } from "./platform.ts";

export type WorkflowPathKind = "image" | "directory";

export type WorkflowFileHostApi = {
  choose(kind: WorkflowPathKind): Promise<string | null>;
};

export function workflowFilePickerAvailable(): boolean {
  return platform() === "desktop" && Boolean(globalThis.window?.auraHost?.workflowFiles);
}

export async function chooseWorkflowPath(
  kind: WorkflowPathKind,
): Promise<string | null> {
  const picker = globalThis.window?.auraHost?.workflowFiles;
  if (!picker) {
    if (platform() === "desktop")
      throw new Error(
        "Aura Desktop 路径选择服务未连接，请完全退出并重新启动 Aura Desktop。",
      );
    throw new Error(
      "本机路径选择需要使用 Aura Desktop；Web 版可粘贴 Aura 服务端可访问的路径。",
    );
  }
  return picker.choose(kind);
}
