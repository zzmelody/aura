import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { SiteProject, SiteStatus } from "@aura/workbench/site";

const STATUS_CHANNEL = "aura:site:status";

contextBridge.exposeInMainWorld("auraHost", {
  platform: "desktop" as const,
  site: {
    chooseDirectory: () =>
      ipcRenderer.invoke(
        "aura:site:choose-directory",
      ) as Promise<SiteProject | null>,
    start: (project: SiteProject) =>
      ipcRenderer.invoke("aura:site:start", project) as Promise<SiteStatus>,
    stop: () => ipcRenderer.invoke("aura:site:stop") as Promise<SiteStatus>,
    open: (url: string) =>
      ipcRenderer.invoke("aura:site:open", url) as Promise<void>,
    onStatus: (callback: (status: SiteStatus) => void) => {
      const listener = (_event: IpcRendererEvent, status: SiteStatus) =>
        callback(status);
      ipcRenderer.on(STATUS_CHANNEL, listener);
      void ipcRenderer.invoke("aura:site:status");
      return () => ipcRenderer.removeListener(STATUS_CHANNEL, listener);
    },
  },
});
