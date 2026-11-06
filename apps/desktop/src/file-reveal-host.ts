import { shell } from "electron";
import { revealTarget } from "./reveal-target.ts";
import { handleNative, NativeOperationError } from "./native-errors.ts";

const CHANNEL = "aura:files:reveal";

/**
 * Shows an existing local file in the file manager. Nothing is
 * opened or executed, so a declared script cannot run from a click.
 */
export function installFileRevealHost(): void {
  handleNative(
    CHANNEL,
    "fileRevealFailed",
    async (event, root: unknown, path: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame)
        throw new NativeOperationError("fileMainWindowOnly");
      const target = await revealTarget(root, path);
      if ("error" in target) throw new NativeOperationError(target.error);
      shell.showItemInFolder(target.path);
    },
  );
}

export { CHANNEL as FILE_REVEAL_CHANNEL };
