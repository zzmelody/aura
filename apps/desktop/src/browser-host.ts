import { randomUUID } from "node:crypto";
import {
  ipcMain,
  session,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import type { BrowserReservation } from "@aura/protocol/browser";
import {
  blocksBrowserRequest,
  browserTarget,
  guestLease,
} from "./browser-policy.ts";

interface BrowserLease {
  partition: string;
  attaching: boolean;
  guest?: WebContents;
}

interface BrowserOwner {
  origin: string;
  reservedPorts: ReadonlySet<string>;
  leases: Map<string, BrowserLease>;
}

const owners = new Map<number, BrowserOwner>();
/** Ports of every Aura window; shared partitions must block all of them. */
const reservedPorts = new Set<string>();
/**
 * One memory-only partition per workspace, like DSH's sidebar browser: tabs in
 * a workspace share cookies and storage until the app exits. Releasing a tab or
 * reloading the renderer keeps the partition.
 */
const partitions = new Map<string, string>();

function ownerOf(event: IpcMainInvokeEvent): BrowserOwner {
  const owner = owners.get(event.sender.id);
  const frame = event.senderFrame;
  if (
    !owner ||
    !frame ||
    frame !== event.sender.mainFrame ||
    URL.parse(frame.url)?.origin !== owner.origin
  )
    throw new Error("浏览器操作只能由 Aura 工作台发起。");
  return owner;
}

function workspacePartition(workspace: unknown): string {
  if (typeof workspace !== "string" || !workspace || workspace.length > 4096)
    throw new Error("浏览器需要所属工作空间。");
  const existing = partitions.get(workspace);
  if (existing) return existing;
  const id = `aura-browser-${randomUUID()}`;
  // No `persist:` prefix: the partition never touches disk or the workbench's storage.
  const partition = session.fromPartition(id, { cache: false });
  partition.setPermissionCheckHandler(() => false);
  partition.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  partition.setDevicePermissionHandler(() => false);
  partition.on("will-download", (download) => download.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: blocksBrowserRequest(details.url, reservedPorts) });
  });
  partitions.set(workspace, id);
  return id;
}

async function release(owner: BrowserOwner, id: string): Promise<void> {
  const lease = owner.leases.get(id);
  if (!lease) return;
  owner.leases.delete(id);
  if (lease.guest && !lease.guest.isDestroyed()) lease.guest.close();
}

function guestOf(owner: BrowserOwner, id: unknown): WebContents | undefined {
  const guest =
    typeof id === "string" ? owner.leases.get(id)?.guest : undefined;
  return guest && !guest.isDestroyed() ? guest : undefined;
}

export function installBrowserHost(): void {
  ipcMain.handle(
    "aura:browser:acquire",
    (event, workspace: unknown): BrowserReservation => {
      const owner = ownerOf(event);
      if (owner.leases.size >= 12) throw new Error("浏览器标签数已达上限。");
      const partition = workspacePartition(workspace);
      const lease = randomUUID();
      owner.leases.set(lease, { partition, attaching: false });
      return { lease, partition };
    },
  );
  ipcMain.handle("aura:browser:release", async (event, id: unknown) => {
    const owner = ownerOf(event);
    if (typeof id === "string") await release(owner, id);
  });
  ipcMain.handle(
    "aura:browser:navigate",
    async (event, id: unknown, value: unknown) => {
      const owner = ownerOf(event);
      const guest = guestOf(owner, id);
      const url = browserTarget(value, owner.reservedPorts);
      if (!guest || !url) throw new Error("不能在 Aura 浏览器打开这个地址。");
      await guest.loadURL(url.href);
    },
  );
  ipcMain.handle("aura:browser:external", async (event, id: unknown) => {
    const owner = ownerOf(event);
    const guest = guestOf(owner, id);
    const url = guest
      ? browserTarget(guest.getURL(), owner.reservedPorts)
      : undefined;
    if (url) await shell.openExternal(url.href);
  });
}

/** Only this window's one-use reservations can attach a guest. */
export function registerBrowserOwner(
  window: BrowserWindow,
  rendererUrl: string,
): void {
  const renderer = new URL(rendererUrl);
  const owner: BrowserOwner = {
    origin: renderer.origin,
    reservedPorts: new Set(["4311", renderer.port || "80"]),
    leases: new Map(),
  };
  for (const port of owner.reservedPorts) reservedPorts.add(port);
  const contents = window.webContents;
  const contentsId = contents.id;
  owners.set(contentsId, owner);
  const reset = () => {
    for (const id of owner.leases.keys()) void release(owner, id);
  };
  contents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) reset();
  });
  contents.on("render-process-gone", reset);
  contents.once("destroyed", () => {
    owners.delete(contentsId);
    reset();
  });
  contents.on("will-attach-webview", (event, preferences, params) => {
    // The first document is an inert `about:blank#<lease>` naming the reservation.
    const lease = owner.leases.get(guestLease(params.src) ?? "");
    if (!lease || lease.attaching || params.partition !== lease.partition) {
      event.preventDefault();
      return;
    }
    lease.attaching = true;
    // Ignore all preferences passed by the renderer, especially preload and Node access.
    for (const key of Object.keys(preferences) as Array<
      keyof typeof preferences
    >)
      delete preferences[key];
    Object.assign(preferences, {
      partition: lease.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    });
    delete params.preload;
  });
  contents.on("did-attach-webview", (_event, guest) => {
    const guard = (event: { url: string; preventDefault(): void }) => {
      if (
        !guestLease(event.url) &&
        !browserTarget(event.url, owner.reservedPorts)
      )
        event.preventDefault();
    };
    guest.on("will-frame-navigate", guard);
    guest.on("will-redirect", guard);
    guest.on("will-attach-webview", (event) => event.preventDefault());
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    // Bind before the renderer can navigate: `navigate` requires a bound guest.
    guest.once("dom-ready", () => {
      const id = guestLease(guest.getURL()) ?? "";
      const lease = owner.leases.get(id);
      if (!lease || !lease.attaching || lease.guest) {
        guest.close();
        return;
      }
      lease.guest = guest;
      guest.once("destroyed", () => owner.leases.delete(id));
    });
  });
}
