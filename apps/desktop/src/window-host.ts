import { BrowserWindow, ipcMain, nativeTheme } from "electron";

/** A single appearance setting; native caption controls still belong to Electron. */
export function installWindowHost() {
  ipcMain.handle("aura:window:theme", (event, dark: unknown, mode: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (
      typeof dark !== "boolean" ||
      !window ||
      event.senderFrame !== event.sender.mainFrame
    )
      return;
    if (process.platform === "darwin") {
      if (mode === "system" || mode === "light" || mode === "dark")
        nativeTheme.themeSource = mode;
    } else {
      window.setTitleBarOverlay({
        // The renderer paints one continuous title bar beneath native controls.
        color: "#00000000",
        symbolColor: dark ? "#b5b5c0" : "#62626c",
        height: 38,
      });
    }
  });
}

/** Restore the macOS material after the window is shown or deminiaturized. */
export function installWorkbenchBackdrop(window: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  let glass: boolean | undefined;
  const paint = (visible: boolean) => {
    if (window.isDestroyed()) return;
    const next = visible && !nativeTheme.prefersReducedTransparency;
    if (!next)
      window.setBackgroundColor(
        nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#f9fafb",
      );
    if (next === glass) return;
    glass = next;
    window.setVibrancy(next ? "sidebar" : null);
    if (next) window.setBackgroundColor("#00000000");
  };
  const refresh = () => paint(window.isVisible() && !window.isMinimized());
  window.on("show", () => paint(true));
  window.on("hide", () => paint(false));
  window.on("minimize", () => paint(false));
  window.on("restore", () => paint(true));
  nativeTheme.on("updated", refresh);
  window.once("closed", () => nativeTheme.removeListener("updated", refresh));
  refresh();
}
