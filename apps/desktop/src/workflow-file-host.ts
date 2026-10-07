import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import type { WorkflowPathKind } from "@aura/workbench/file-picker";

const CHANNEL = "aura:workflow-files:choose";

async function choosePath(
  event: IpcMainInvokeEvent,
  kind: WorkflowPathKind,
): Promise<string | null> {
  if (kind !== "image" && kind !== "directory")
    throw new Error("不支持的路径选择类型。");
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options: OpenDialogOptions =
    kind === "directory"
      ? {
          title: "选择工作流输出目录",
          buttonLabel: "选择此目录",
          properties: ["openDirectory", "createDirectory"],
        }
      : {
          title: "选择工作流输入图片",
          buttonLabel: "使用此图片",
          properties: ["openFile"],
          filters: [
            {
              name: "图片",
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
  ipcMain.handle(CHANNEL, choosePath);
}

export { CHANNEL as WORKFLOW_FILE_CHANNEL };
