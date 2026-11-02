import { contextBridge, ipcRenderer } from "electron";
import type { WorkflowPathKind } from "@aura/workbench/file-picker";

contextBridge.exposeInMainWorld("auraHost", {
  platform: "desktop" as const,
  os: process.platform,
  chrome: {
    setTheme: (dark: boolean) =>
      ipcRenderer.invoke("aura:window:theme", dark) as Promise<void>,
  },
  files: {
    reveal: async (root: string, path: string): Promise<void> => {
      const result: unknown = await ipcRenderer
        .invoke("aura:files:reveal", root, path)
        .catch(() => ({ error: "无法在文件夹中显示，请重试。" }));
      if (typeof result === "object" && result !== null && "error" in result) {
        if (result.error === null) return;
        if (typeof result.error === "string") throw new Error(result.error);
      }
      throw new Error("无法在文件夹中显示，请重试。");
    },
  },
  workflowFiles: {
    choose: (kind: WorkflowPathKind) =>
      ipcRenderer.invoke("aura:workflow-files:choose", kind) as Promise<
        string | null
      >,
  },
  directories: {
    choose: () =>
      ipcRenderer.invoke("aura:directories:choose") as Promise<string | null>,
  },
  previews: {
    open: (url: string, id: string, title: string) =>
      ipcRenderer.invoke("aura:previews:open", url, id, title) as Promise<void>,
  },
});
