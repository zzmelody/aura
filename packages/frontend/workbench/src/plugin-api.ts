/** Public, browser-safe primitives shared by product plugins and core pages. */
export * from "./plugin-transport.ts";
export { NestedFlowRun } from "./screens/WorkflowRun.tsx";
export { WorkflowControls } from "./screens/WorkflowControls.tsx";
export { WorkflowVideoResult } from "./screens/WorkflowVideoResult.tsx";
export { platform } from "./platform.ts";

export function siteDialogsAvailable(): boolean {
  const host = globalThis.window?.auraHost;
  return Boolean(host?.directories?.choose && host.previews?.open);
}

/** Native dialogs and windows stay in the desktop host, not plugin Node code. */
export function chooseSiteDirectory(): Promise<string | null> {
  const choose = globalThis.window?.auraHost?.directories?.choose;
  if (!choose) throw new Error("目录选择仅支持 Aura Desktop。");
  return choose();
}

export function openSitePreview(
  url: string,
  id: string,
  title: string,
): Promise<void> {
  const open = globalThis.window?.auraHost?.previews?.open;
  if (!open) throw new Error("站点预览仅支持 Aura Desktop。");
  return open(url, id, title);
}
