import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import {
  describeProject,
  SiteRunner,
  type SiteProject,
} from "@aura/runtime/site";

const STATUS_CHANNEL = "aura:site:status";
const SITE_URL_PATTERN = /^https?:\/\//i;
const siteWindows = new Map<string, BrowserWindow>();
const subscribers = new Set<Electron.WebContents>();
const runner = new SiteRunner({
  onStatus(status) {
    for (const contents of subscribers) {
      if (contents.isDestroyed()) subscribers.delete(contents);
      else contents.send(STATUS_CHANNEL, status);
    }
  },
  openPreview: (url, project) => openSiteWindow(url, project),
});

async function openSiteWindow(
  url: string,
  project?: SiteProject,
): Promise<void> {
  const id = project?.id ?? url;
  let window = siteWindows.get(id);
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 520,
      title: `Aura · ${project?.name ?? "Site"}`,
      backgroundColor: "#0C0B10",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    siteWindows.set(id, window);
    window.on("closed", () => {
      if (siteWindows.get(id) === window) siteWindows.delete(id);
    });
    window.webContents.setWindowOpenHandler(({ url: requested }) =>
      SITE_URL_PATTERN.test(requested)
        ? { action: "allow" }
        : { action: "deny" },
    );
    window.webContents.on("will-navigate", (event, requested) => {
      if (!SITE_URL_PATTERN.test(requested)) event.preventDefault();
    });
  }
  await window.loadURL(url);
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
  }
}

async function chooseDirectory(
  event: IpcMainInvokeEvent,
): Promise<SiteProject | null> {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options: OpenDialogOptions = {
    title: "选择前端项目目录",
    buttonLabel: "使用这个目录",
    properties: ["openDirectory"],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return describeProject(result.filePaths[0]);
}

export function installSiteHost(): void {
  ipcMain.handle("aura:site:choose-directory", chooseDirectory);
  ipcMain.handle("aura:site:start", (_event, project: unknown) =>
    runner.start(project),
  );
  ipcMain.handle("aura:site:stop", (_event, id: unknown) => {
    if (typeof id !== "string") throw new Error("无效的 Site 项目标识。");
    return runner.stop(id);
  });
  ipcMain.handle("aura:site:open", (_event, project: unknown) => {
    if (!project || typeof project !== "object")
      throw new Error("无效的 Site 项目。");
    return runner.open(project as SiteProject);
  });
  ipcMain.handle("aura:site:status", (event) => {
    subscribers.add(event.sender);
    for (const status of runner.getStatuses())
      event.sender.send(STATUS_CHANNEL, status);
    return runner.getStatuses();
  });
}

export async function closeSiteHost(): Promise<void> {
  await runner.stop();
  for (const window of siteWindows.values())
    if (!window.isDestroyed()) window.close();
  siteWindows.clear();
}

export { STATUS_CHANNEL };
