import { BrowserWindow, ipcMain } from "electron";

/** A single appearance setting; native caption controls still belong to Electron. */
export function installWindowHost() {
  ipcMain.handle("aura:window:theme", (event, dark: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (
      typeof dark !== "boolean" ||
      !window ||
      event.senderFrame !== event.sender.mainFrame
    )
      return;
    if (process.platform !== "darwin")
      window.setTitleBarOverlay({
        // The renderer paints one continuous title bar beneath native controls.
        color: "#00000000",
        symbolColor: dark ? "#b5b5c0" : "#62626c",
        height: 38,
      });
  });
}
