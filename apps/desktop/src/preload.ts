import { contextBridge, ipcRenderer } from "electron";
import type { WorkflowPathKind } from "@aura/workbench/file-picker";
import type { BrowserHost, BrowserReservation } from "@aura/protocol/browser";

contextBridge.exposeInMainWorld("auraHost", {
  platform: "desktop" as const,
  os: process.platform,
  chrome: {
    setTheme: (dark: boolean, mode?: "system" | "light" | "dark") =>
      ipcRenderer.invoke("aura:window:theme", dark, mode) as Promise<void>,
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
  browser: {
    acquire: (workspace: string): Promise<BrowserReservation> =>
      ipcRenderer.invoke("aura:browser:acquire", workspace),
    release: (id: string): Promise<void> =>
      ipcRenderer.invoke("aura:browser:release", id),
    navigate: (id: string, url: string): Promise<void> =>
      ipcRenderer.invoke("aura:browser:navigate", id, url),
    openExternal: (id: string): Promise<void> =>
      ipcRenderer.invoke("aura:browser:external", id),
  } satisfies BrowserHost,
});
