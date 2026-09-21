import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { SiteProject, SiteStatus } from "@aura/workbench/site";
import type { WorkflowPathKind } from "@aura/workbench/file-picker";

const STATUS_CHANNEL = "aura:site:status";

contextBridge.exposeInMainWorld("auraHost", {
  platform: "desktop" as const,
  workflowFiles: {
    choose: (kind: WorkflowPathKind) =>
      ipcRenderer.invoke("aura:workflow-files:choose", kind) as Promise<
        string | null
      >,
  },
  site: {
    chooseDirectory: () =>
      ipcRenderer.invoke(
        "aura:site:choose-directory",
      ) as Promise<SiteProject | null>,
    start: (project: SiteProject) =>
      ipcRenderer.invoke("aura:site:start", project) as Promise<SiteStatus>,
    stop: (id: string) =>
      ipcRenderer.invoke("aura:site:stop", id) as Promise<SiteStatus>,
    open: (project: SiteProject) =>
      ipcRenderer.invoke("aura:site:open", project) as Promise<void>,
    onStatus: (callback: (status: SiteStatus) => void) => {
      const listener = (_event: IpcRendererEvent, status: SiteStatus) =>
        callback(status);
      ipcRenderer.on(STATUS_CHANNEL, listener);
      void ipcRenderer.invoke("aura:site:status");
      return () => ipcRenderer.removeListener(STATUS_CHANNEL, listener);
    },
  },
});
