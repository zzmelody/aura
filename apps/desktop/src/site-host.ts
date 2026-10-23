import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
const SITE_URL_PATTERN = /^https?:\/\//i;
const siteWindows = new Map<string, BrowserWindow>();

async function openSiteWindow(
  url: string,
  project?: { id: string; name: string },
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
): Promise<string | null> {
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
  return result.filePaths[0];
}

export function installSiteHost(): void {
  ipcMain.handle("aura:directories:choose", chooseDirectory);
  ipcMain.handle(
    "aura:previews:open",
    async (_event, url: unknown, id: unknown, name: unknown) => {
      if (
        typeof url !== "string" ||
        typeof id !== "string" ||
        typeof name !== "string" ||
        id.length > 4096 ||
        name.length > 256
      )
        throw new Error("无效的站点预览。");
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
        parsed.username ||
        parsed.password
      )
        throw new Error("预览地址必须是本机 HTTP 站点。");
      await openSiteWindow(parsed.href, { id, name });
    },
  );
}

export async function closeSiteHost(): Promise<void> {
  for (const window of siteWindows.values())
    if (!window.isDestroyed()) window.close();
  siteWindows.clear();
}
