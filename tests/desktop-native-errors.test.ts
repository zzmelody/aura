import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  isNativeFailure,
  type NativeFailureCode,
} from "@aura/protocol/native-ui";
import { revealTarget } from "../apps/desktop/src/reveal-target.ts";
import * as browserPolicy from "../apps/desktop/src/browser-policy.ts";

test("desktop operations return stable failure codes and discard raw OS exceptions while preserving their guards", async (t) => {
  // Synthetic Electron ports exercise the actual IPC handlers; only a temporary file is created.
  const directory = await mkdtemp(join(tmpdir(), "aura-native-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "file.txt");
  await writeFile(path, "fixture");
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const frame = { url: "http://127.0.0.1:8082/" };
  const sender = {
    id: 1,
    mainFrame: frame,
    on: (name: string, callback: (...args: unknown[]) => void) =>
      listeners.set(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) =>
      listeners.set(name, callback),
  };
  const event = { sender, senderFrame: frame };
  let failReveal = false;
  let dialogs = 0;
  const revealed: string[] = [];
  const privateError = "C:/private/OS-detail-not-for-clients";
  const electron = {
    ipcMain: {
      handle: (
        name: string,
        callback: (...args: unknown[]) => Promise<unknown>,
      ) => handlers.set(name, callback),
    },
    shell: {
      showItemInFolder: (value: string) => {
        if (failReveal) throw new Error(privateError);
        revealed.push(value);
      },
    },
    BrowserWindow: class {
      static fromWebContents() {
        return undefined;
      }
      constructor() {
        throw new Error(privateError);
      }
    },
    dialog: {
      showOpenDialog: async () => {
        dialogs++;
        throw new Error(privateError);
      },
    },
    session: {
      fromPartition: () => ({
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {},
        setDevicePermissionHandler() {},
        on() {},
        webRequest: { onBeforeRequest() {} },
      }),
    },
  };
  const modules = new Map<string, Record<string, unknown>>();
  async function load(name: string) {
    const source = await readFile(
      new URL(`../apps/desktop/src/${name}.ts`, import.meta.url),
      "utf8",
    );
    const exports: Record<string, unknown> = {};
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      {
        exports,
        URL,
        require: (id: string) => {
          if (id === "electron") return electron;
          if (id === "node:crypto") return { randomUUID };
          if (id === "./reveal-target.ts") return { revealTarget };
          if (id === "./browser-policy.ts") return browserPolicy;
          if (id === "./desktop-messages.ts")
            return { desktopText: (key: string) => key };
          const module = modules.get(id);
          assert.ok(module, id);
          return module;
        },
      },
    );
    modules.set(`./${name}.ts`, exports);
    return exports;
  }
  await load("native-errors");
  const reveal = (await load("file-reveal-host")) as {
    installFileRevealHost(): void;
  };
  const workflow = (await load("workflow-file-host")) as {
    installWorkflowFileHost(): void;
  };
  const site = (await load("site-host")) as { installSiteHost(): void };
  const browser = (await load("browser-host")) as {
    installBrowserHost(): void;
    registerBrowserOwner(
      window: { webContents: typeof sender },
      url: string,
    ): void;
  };
  reveal.installFileRevealHost();
  workflow.installWorkflowFileHost();
  site.installSiteHost();
  browser.installBrowserHost();
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!(event, ...args);
  async function failure(work: Promise<unknown>, code: NativeFailureCode) {
    const value = await work;
    assert.ok(isNativeFailure(value));
    assert.equal(value.code, code);
    assert.deepEqual(Object.keys(value).sort(), ["code", "type"]);
    assert.equal(JSON.stringify(value).includes(privateError), false);
  }
  await failure(invoke("aura:files:reveal", directory, ""), "filePathInvalid");
  await failure(
    invoke("aura:files:reveal", "relative", "file.txt"),
    "fileRootRequired",
  );
  await failure(
    invoke("aura:files:reveal", directory, "missing.txt"),
    "fileNotFound",
  );
  await failure(
    handlers.get("aura:files:reveal")!(
      { sender, senderFrame: { ...frame } },
      directory,
      path,
    ),
    "fileMainWindowOnly",
  );
  assert.equal(
    await invoke("aura:files:reveal", directory, "file.txt"),
    undefined,
  );
  assert.deepEqual(revealed, [path]);
  failReveal = true;
  await failure(
    invoke("aura:files:reveal", directory, "file.txt"),
    "fileRevealFailed",
  );
  await failure(
    invoke("aura:workflow-files:choose", "unsupported"),
    "pickerKindUnsupported",
  );
  assert.equal(dialogs, 0);
  await failure(invoke("aura:workflow-files:choose", "image"), "pickerFailed");
  await failure(invoke("aura:directories:choose"), "pickerFailed");
  assert.equal(dialogs, 2);
  await failure(
    invoke("aura:previews:open", null, "id", "Title"),
    "previewInvalid",
  );
  await failure(
    invoke("aura:previews:open", "not-a-url", "id", "Title"),
    "previewInvalid",
  );
  await failure(
    invoke("aura:previews:open", "https://example.com", "id", "Title"),
    "previewLocalOnly",
  );
  await failure(
    invoke("aura:previews:open", "http://localhost:5000", "id", "Title"),
    "previewFailed",
  );
  await failure(
    invoke("aura:browser:acquire", "workspace"),
    "browserOwnerRequired",
  );
  browser.registerBrowserOwner({ webContents: sender }, frame.url);
  await failure(invoke("aura:browser:acquire", ""), "browserWorkspaceRequired");
  await failure(
    handlers.get("aura:browser:acquire")!(
      { sender, senderFrame: { ...frame } },
      "workspace",
    ),
    "browserOwnerRequired",
  );
  const leases: string[] = [];
  for (let index = 0; index < 12; index++) {
    const reservation = (await invoke("aura:browser:acquire", "workspace")) as {
      lease: string;
      partition: string;
    };
    assert.ok(reservation.lease && reservation.partition);
    leases.push(reservation.lease);
  }
  await failure(invoke("aura:browser:acquire", "workspace"), "browserTabLimit");
  await failure(
    invoke("aura:browser:navigate", leases[0], "http://localhost:4311"),
    "browserAddressBlocked",
  );
  await invoke("aura:browser:release", leases[0]);
  assert.equal(
    isNativeFailure(await invoke("aura:browser:acquire", "workspace")),
    false,
    "released leases free a slot",
  );
  listeners.get("destroyed")!();
  await failure(
    invoke("aura:browser:acquire", "workspace"),
    "browserOwnerRequired",
  );
});
