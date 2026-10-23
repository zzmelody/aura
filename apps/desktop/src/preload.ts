import { contextBridge, ipcRenderer } from "electron";
import type { WorkflowPathKind } from "@aura/workbench/file-picker";

contextBridge.exposeInMainWorld("auraHost", {
  platform: "desktop" as const,
  chrome: {
    setTheme: (dark: boolean) =>
      ipcRenderer.invoke("aura:window:theme", dark) as Promise<void>,
  },
  files: {
    reveal: (root: string, path: string) =>
      ipcRenderer.invoke("aura:files:reveal", root, path) as Promise<void>,
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
