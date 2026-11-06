import type { WorkflowFileHostApi } from "./file-picker.ts";
import type { BrowserHost } from "@aura/protocol/browser";
import type { ThemeMode } from "@aura/core/types";
import { MessageError, type Locale } from "@aura/i18n/runtime";
import "./auth-messages.ts";
import type { NativeHost } from "@aura/protocol/native-ui";
import { nativeCall } from "./native-messages.ts";

export type AuraPlatform = "web" | "desktop" | "mobile";

declare global {
  interface Window {
    auraHost?: {
      platform: AuraPlatform;
      /** Native host OS, supplied by the desktop preload. */
      os?: string;
      openExternal?(url: string): Promise<void>;
      directories?: NativeHost<{ choose(): Promise<string | null> }>;
      previews?: NativeHost<{
        open(url: string, id: string, title: string): Promise<void>;
      }>;
      browser?: NativeHost<BrowserHost>;
      workflowFiles?: NativeHost<WorkflowFileHostApi>;
      /** Show an existing local file in the file manager; never opens it. */
      files?: NativeHost<{ reveal(root: string, path: string): Promise<void> }>;
      chrome?: {
        setTheme(dark: boolean, mode?: ThemeMode): Promise<void>;
        setLanguage?(locale: Locale): Promise<void>;
      };
    };
  }
}

const browsers = new WeakMap<NativeHost<BrowserHost>, BrowserHost>();
/** Stable adapter identity prevents language renders from recreating browser leases. */
export function desktopBrowserHost(): BrowserHost | undefined {
  const native = globalThis.window?.auraHost?.browser;
  if (!native) return undefined;
  let host = browsers.get(native);
  if (!host) {
    host = {
      acquire: (workspace) => nativeCall(() => native.acquire(workspace)),
      release: (id) => nativeCall(() => native.release(id)),
      navigate: (id, url) => nativeCall(() => native.navigate(id, url)),
      openExternal: (id) => nativeCall(() => native.openExternal(id)),
    };
    browsers.set(native, host);
  }
  return host;
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
  if (!opened)
    throw new MessageError({ namespace: "auth", key: "popupBlocked" });
}
