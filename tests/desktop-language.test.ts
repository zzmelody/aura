import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  createLanguageController,
  locales,
  registerCatalogs,
} from "@aura/i18n/runtime";
import {
  desktopCatalogs,
  desktopText,
  type DesktopMessageKey,
} from "../apps/desktop/src/desktop-messages.ts";

async function moduleSource(name: string): Promise<string> {
  return ts.transpileModule(
    await readFile(
      new URL(`../apps/desktop/src/${name}.ts`, import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
}

test("native dialogs use the accepted workbench language without changing paths or persisting a second preference", async () => {
  // Electron ports are synthetic: no window, real picker, or user directory is opened.
  const language = createLanguageController();
  registerCatalogs("desktop", desktopCatalogs, language.i18n);
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const windows = new Map<string, () => void>();
  const frame = { url: "http://127.0.0.1:56789/" };
  const sender = { id: 1, mainFrame: frame };
  const event = { sender, senderFrame: frame };
  const window = {
    webContents: sender,
    once: (name: string, callback: () => void) => windows.set(name, callback),
  };
  const options: Array<{
    title: string;
    buttonLabel: string;
    properties: string[];
    filters?: Array<{ name: string; extensions: string[] }>;
  }> = [];
  let canceled = false;
  let systemReads = 0;
  const electron = {
    app: {
      getPreferredSystemLanguages: () => {
        systemReads++;
        return ["de-DE", "ja-JP"];
      },
    },
    ipcMain: {
      handle: (
        name: string,
        callback: (...args: unknown[]) => Promise<unknown>,
      ) => handlers.set(name, callback),
    },
    BrowserWindow: { fromWebContents: () => window },
    dialog: {
      showOpenDialog: async (
        parent: unknown,
        value: (typeof options)[number],
      ) => {
        assert.equal(parent, window);
        options.push(value);
        return { canceled, filePaths: ["C:/原始名称/project"] };
      },
    },
  };
  const host: {
    installLanguageHost?: () => void;
    initializeNativeLanguage?: () => Promise<void>;
    registerLanguageOwner?: (owner: typeof window, url: string) => void;
  } = {};
  const translations = {
    desktopText: (key: DesktopMessageKey) => desktopText(key, language.i18n),
  };
  const nativeErrors: Record<string, unknown> = {};
  const dependencies = (name: string) => {
    if (name === "electron") return electron;
    if (name === "@aura/i18n/runtime")
      return {
        language,
        isLocale: (value: unknown) =>
          locales.some((locale) => locale === value),
      };
    if (name === "./desktop-messages.ts") return translations;
    if (name === "./native-errors.ts") return nativeErrors;
    throw new Error(`Unexpected module ${name}`);
  };
  runInNewContext(await moduleSource("native-errors"), {
    exports: nativeErrors,
    require: dependencies,
  });
  runInNewContext(await moduleSource("language-host"), {
    exports: host,
    require: dependencies,
    URL,
  });
  host.installLanguageHost!();
  await host.initializeNativeLanguage!();
  assert.equal(language.getSnapshot().locale, "ja");
  assert.equal(systemReads, 1);
  const set = handlers.get("aura:window:language")!;
  await set(event, "fr");
  assert.equal(
    language.getSnapshot().locale,
    "ja",
    "unregistered renderer is ignored",
  );
  host.registerLanguageOwner!(window, frame.url);
  for (const value of ["de", "fr-FR", "system", {}, null])
    await set(event, value);
  await set({ sender, senderFrame: { ...frame } }, "ru");
  const original = frame.url;
  frame.url = "https://example.com";
  await set(event, "fr");
  frame.url = original;
  assert.equal(
    language.getSnapshot().locale,
    "ja",
    "invalid locales, subframes and foreign origins are ignored",
  );

  const workflow: { installWorkflowFileHost?: () => void } = {};
  runInNewContext(await moduleSource("workflow-file-host"), {
    exports: workflow,
    require: dependencies,
  });
  workflow.installWorkflowFileHost!();
  const site: { installSiteHost?: () => void } = {};
  runInNewContext(await moduleSource("site-host"), {
    exports: site,
    require: dependencies,
  });
  site.installSiteHost!();
  const choose = handlers.get("aura:workflow-files:choose")!;
  const chooseProject = handlers.get("aura:directories:choose")!;
  for (const locale of locales) {
    await set(event, locale);
    const expected = desktopCatalogs[locale];
    assert.equal(await choose(event, "directory"), "C:/原始名称/project");
    assert.equal(options.at(-1)!.title, expected.outputDirectory);
    assert.equal(options.at(-1)!.buttonLabel, expected.selectDirectory);
    assert.deepEqual(
      [...options.at(-1)!.properties],
      ["openDirectory", "createDirectory"],
    );
    assert.equal(await choose(event, "image"), "C:/原始名称/project");
    assert.equal(options.at(-1)!.title, expected.inputImage);
    assert.equal(options.at(-1)!.buttonLabel, expected.useImage);
    assert.equal(options.at(-1)!.filters![0].name, expected.images);
    assert.deepEqual(
      [...options.at(-1)!.filters![0].extensions],
      ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
    );
    assert.equal(await chooseProject(event), "C:/原始名称/project");
    assert.equal(options.at(-1)!.title, expected.projectDirectory);
    assert.equal(options.at(-1)!.buttonLabel, expected.useDirectory);
    assert.equal(
      language.getSnapshot().saveError,
      false,
      "native changes never require storage",
    );
  }
  canceled = true;
  assert.equal(await choose(event, "image"), null);
  assert.equal(await chooseProject(event), null);
  assert.equal(options.length, locales.length * 3 + 2);
  windows.get("closed")!();
  await set(event, "ko");
  assert.equal(
    language.getSnapshot().locale,
    "fr",
    "closed owner can no longer change language",
  );
});

test("the preload bridge forwards locale only and releases its subscription when the renderer closes", async () => {
  const calls: unknown[][] = [];
  const language = createLanguageController({ languages: ["ko-KR"] });
  const exposed: {
    auraHost?: { chrome: { setLanguage(locale: string): Promise<void> } };
  } = {};
  runInNewContext(await moduleSource("preload"), {
    exports: {},
    process: { platform: "win32" },
    require: (name: string) => {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (
            key: "auraHost",
            value: typeof exposed.auraHost,
          ) => {
            exposed[key] = value;
          },
        },
        ipcRenderer: {
          invoke: async (...args: unknown[]) => {
            calls.push(args);
          },
        },
      };
    },
  });
  const events = new Map<string, () => void>();
  const window = {
    auraHost: exposed.auraHost,
    addEventListener: (name: string, callback: () => void) =>
      events.set(name, callback),
    removeEventListener: (name: string) => events.delete(name),
  };
  const bridge: { startDesktopLanguageBridge?: () => () => void } = {};
  runInNewContext(await moduleSource("language-bridge"), {
    exports: bridge,
    window,
    require: (name: string) => {
      assert.equal(name, "@aura/i18n/runtime");
      return { language };
    },
  });
  const dispose = bridge.startDesktopLanguageBridge!();
  assert.deepEqual(calls, [["aura:window:language", "ko"]]);
  for (const locale of locales) {
    await language.systemChanged([locale]);
    assert.deepEqual(calls.at(-1), ["aura:window:language", locale]);
  }
  await language.systemChanged(["fr-CA"]);
  assert.equal(calls.length, 7, "unchanged effective locale is not sent again");
  events.get("pagehide")!();
  await language.systemChanged(["ja"]);
  assert.equal(calls.length, 7);
  assert.equal(events.size, 0);
  dispose();
  window.auraHost = undefined;
  assert.doesNotThrow(() => bridge.startDesktopLanguageBridge!()());
});
