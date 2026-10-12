import { ipcMain, shell } from "electron";
import { revealTarget } from "./reveal-target.ts";

const CHANNEL = "aura:files:reveal";

/**
 * Shows a project file in the system file manager. Reveal only: nothing is
 * opened or executed, so a declared script cannot run from a click.
 */
export function installFileRevealHost(): void {
  ipcMain.handle(CHANNEL, async (event, root: unknown, path: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error("只能从主窗口定位文件。");
    const target = await revealTarget(root, path);
    if ("error" in target) throw new Error(target.error);
    shell.showItemInFolder(target.path);
  });
}

export { CHANNEL as FILE_REVEAL_CHANNEL };
