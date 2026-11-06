import {
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { desktopText as t } from "./desktop-messages.ts";
import { handleNative, NativeOperationError } from "./native-errors.ts";
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
    title: t("projectDirectory"),
    buttonLabel: t("useDirectory"),
    properties: ["openDirectory"],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

export function installSiteHost(): void {
  handleNative("aura:directories:choose", "pickerFailed", chooseDirectory);
  handleNative(
    "aura:previews:open",
    "previewFailed",
    async (_event, url: unknown, id: unknown, name: unknown) => {
      if (
        typeof url !== "string" ||
        typeof id !== "string" ||
        typeof name !== "string" ||
        id.length > 4096 ||
        name.length > 256
      )
        throw new NativeOperationError("previewInvalid");
      const parsed = URL.parse(url);
      if (!parsed) throw new NativeOperationError("previewInvalid");
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
        parsed.username ||
        parsed.password
      )
        throw new NativeOperationError("previewLocalOnly");
      await openSiteWindow(parsed.href, { id, name });
    },
  );
}

export async function closeSiteHost(): Promise<void> {
  for (const window of siteWindows.values())
    if (!window.isDestroyed()) window.close();
  siteWindows.clear();
}
