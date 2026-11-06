import { platform } from "./platform.ts";
import { MessageError } from "@aura/i18n/runtime";
import { workflowMessage as message } from "./workflow-messages.ts";
import { nativeCall } from "./native-messages.ts";

export type WorkflowPathKind = "image" | "directory";

export type WorkflowFileHostApi = {
  choose(kind: WorkflowPathKind): Promise<string | null>;
};

export function workflowFilePickerAvailable(): boolean {
  return (
    platform() === "desktop" &&
    Boolean(globalThis.window?.auraHost?.workflowFiles)
  );
}

export async function chooseWorkflowPath(
  kind: WorkflowPathKind,
): Promise<string | null> {
  const picker = globalThis.window?.auraHost?.workflowFiles;
  if (!picker) {
    if (platform() === "desktop")
      throw new MessageError(message("pickerDisconnected"));
    throw new MessageError(message("pickerDesktopOnly"));
  }
  return nativeCall(() => picker.choose(kind));
}
