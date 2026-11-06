import {
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { desktopText as t } from "./desktop-messages.ts";
import { handleNative, NativeOperationError } from "./native-errors.ts";

const CHANNEL = "aura:workflow-files:choose";

async function choosePath(
  event: IpcMainInvokeEvent,
  kind: unknown,
): Promise<string | null> {
  if (kind !== "image" && kind !== "directory")
    throw new NativeOperationError("pickerKindUnsupported");
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options: OpenDialogOptions =
    kind === "directory"
      ? {
          title: t("outputDirectory"),
          buttonLabel: t("selectDirectory"),
          properties: ["openDirectory", "createDirectory"],
        }
      : {
          title: t("inputImage"),
          buttonLabel: t("useImage"),
          properties: ["openFile"],
          filters: [
            {
              name: t("images"),
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            },
          ],
        };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function installWorkflowFileHost(): void {
  handleNative(CHANNEL, "pickerFailed", choosePath);
}

export { CHANNEL as WORKFLOW_FILE_CHANNEL };
