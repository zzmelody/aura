import { app, ipcMain, type BrowserWindow } from "electron";
import { isLocale, language } from "@aura/i18n/runtime";

const owners = new Map<number, string>();

/** No additional settings file: the renderer owns the existing UI preference. */
export function installLanguageHost(): void {
  ipcMain.handle("aura:window:language", async (event, locale: unknown) => {
    const origin = owners.get(event.sender.id);
    const frame = event.senderFrame;
    if (
      !origin ||
      !frame ||
      frame !== event.sender.mainFrame ||
      URL.parse(frame.url)?.origin !== origin ||
      !isLocale(locale)
    )
      return;
    await language.systemChanged([locale]);
  });
}

/** Called after app.ready, before a renderer can supply its device preference. */
export async function initializeNativeLanguage(): Promise<void> {
  await language.systemChanged(app.getPreferredSystemLanguages());
}

export function registerLanguageOwner(
  window: BrowserWindow,
  rendererUrl: string,
): void {
  const id = window.webContents.id;
  owners.set(id, new URL(rendererUrl).origin);
  window.once("closed", () => owners.delete(id));
}
