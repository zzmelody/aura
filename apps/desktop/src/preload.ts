import { contextBridge, ipcRenderer } from "electron";
import type { WorkflowPathKind } from "@aura/workbench/file-picker";
import type { BrowserHost, BrowserReservation } from "@aura/protocol/browser";
import type { Locale } from "@aura/i18n/runtime";
import type {
  NativeFailure,
  NativeFailureCode,
  NativeHost,
} from "@aura/protocol/native-ui";

/** No runtime imports beyond Electron are available in the sandboxed preload. */
async function invokeNative<Value>(
  channel: string,
  fallback: NativeFailureCode,
  ...args: unknown[]
): Promise<Value | NativeFailure> {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch {
    // Never expose Electron's wrapper, OS paths or raw exception details.
    return { type: "aura.native.failure", code: fallback };
  }
}

contextBridge.exposeInMainWorld("auraHost", {
  platform: "desktop" as const,
  os: process.platform,
  chrome: {
    setLanguage: (locale: Locale) =>
      ipcRenderer.invoke("aura:window:language", locale) as Promise<void>,
    setTheme: (dark: boolean, mode?: "system" | "light" | "dark") =>
      ipcRenderer.invoke("aura:window:theme", dark, mode) as Promise<void>,
  },
  files: {
    reveal: (root: string, path: string) =>
      invokeNative<void>("aura:files:reveal", "fileRevealFailed", root, path),
  },
  workflowFiles: {
    choose: (kind: WorkflowPathKind) =>
      invokeNative<string | null>(
        "aura:workflow-files:choose",
        "pickerFailed",
        kind,
      ),
  },
  directories: {
    choose: () =>
      invokeNative<string | null>("aura:directories:choose", "pickerFailed"),
  },
  previews: {
    open: (url: string, id: string, title: string) =>
      invokeNative<void>("aura:previews:open", "previewFailed", url, id, title),
  },
  browser: {
    acquire: (workspace: string) =>
      invokeNative<BrowserReservation>(
        "aura:browser:acquire",
        "browserOperationFailed",
        workspace,
      ),
    release: (id: string) =>
      invokeNative<void>("aura:browser:release", "browserOperationFailed", id),
    navigate: (id: string, url: string) =>
      invokeNative<void>(
        "aura:browser:navigate",
        "browserOperationFailed",
        id,
        url,
      ),
    openExternal: (id: string) =>
      invokeNative<void>("aura:browser:external", "browserOperationFailed", id),
  } satisfies NativeHost<BrowserHost>,
});
