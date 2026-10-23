import type { WorkflowFileHostApi } from "./file-picker.ts";

export type AuraPlatform = "web" | "desktop" | "mobile";

declare global {
  interface Window {
    auraHost?: {
      platform: AuraPlatform;
      openExternal?(url: string): Promise<void>;
      directories?: { choose(): Promise<string | null> };
      previews?: {
        open(url: string, id: string, title: string): Promise<void>;
      };
      workflowFiles?: WorkflowFileHostApi;
      /** Show a project file in the system file manager; never opens it. */
      files?: { reveal(root: string, path: string): Promise<void> };
      chrome?: { setTheme(dark: boolean): Promise<void> };
    };
  }
}

export function platform(): AuraPlatform {
  return globalThis.window?.auraHost?.platform ?? "web";
}

export async function openExternal(url: string): Promise<void> {
  const host = globalThis.window?.auraHost;
  if (host?.openExternal) {
    await host.openExternal(url);
    return;
  }
  const opened = globalThis.open(url, "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("浏览器阻止了登录窗口，请允许弹出窗口后重试。");
}
