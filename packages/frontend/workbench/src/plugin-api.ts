/** Public, browser-safe primitives shared by product plugins and core pages. */
import { MessageError } from "@aura/i18n/runtime";
import { pluginMessage } from "./plugin-messages.ts";
import { nativeCall } from "./native-messages.ts";
export * from "./plugin-transport.ts";
export { NestedFlowRun } from "./screens/WorkflowRun.tsx";
export { WorkflowControls } from "./screens/WorkflowControls.tsx";
export { platform } from "./platform.ts";

export function siteDialogsAvailable(): boolean {
  const host = globalThis.window?.auraHost;
  return Boolean(host?.directories?.choose && host.previews?.open);
}

/** Native dialogs and windows stay in the desktop host, not plugin Node code. */
export function chooseSiteDirectory(): Promise<string | null> {
  const choose = globalThis.window?.auraHost?.directories?.choose;
  if (!choose) throw new MessageError(pluginMessage("directoryDesktopOnly"));
  return nativeCall(choose);
}

export function openSitePreview(
  url: string,
  id: string,
  title: string,
): Promise<void> {
  const open = globalThis.window?.auraHost?.previews?.open;
  if (!open) throw new MessageError(pluginMessage("previewDesktopOnly"));
  return nativeCall(() => open(url, id, title));
}
