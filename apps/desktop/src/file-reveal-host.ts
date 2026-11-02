import { ipcMain, shell } from "electron";
import { revealTarget } from "./reveal-target.ts";

const CHANNEL = "aura:files:reveal";

/**
 * Shows an existing local file in the file manager. Nothing is
 * opened or executed, so a declared script cannot run from a click.
 */
export function installFileRevealHost(): void {
  ipcMain.handle(CHANNEL, async (event, root: unknown, path: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame)
      return { error: "只能从主窗口定位文件。" };
    const target = await revealTarget(root, path);
    if ("error" in target) return target;
    try {
      shell.showItemInFolder(target.path);
      return { error: null };
    } catch {
      return { error: "无法在文件夹中显示，请重试。" };
    }
  });
}

export { CHANNEL as FILE_REVEAL_CHANNEL };
