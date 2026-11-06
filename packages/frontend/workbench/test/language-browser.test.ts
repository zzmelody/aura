import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "vite";

const chrome = process.env.CHROME_BIN;

test(
  "six language choices update host and plugin text without remounting or losing settings drafts",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to run the language browser check"
        : false,
    timeout: 45_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-languages-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const module = (name: string) =>
      JSON.stringify(fileURLToPath(import.meta.resolve(name)));
    const source = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(directory, "fixture.ts");
    await writeFile(
      entry,
      `
import React from ${module("react")};
import { createRoot } from ${module("react-dom/client")};
import { flushSync } from ${module("react-dom")};
import { LanguageProvider } from ${module("@aura/i18n")};
import { language, registerCatalogs } from ${module("@aura/i18n/runtime")};
import { usePluginTranslation } from ${module("@aura/plugin-ui")};
import { initialState } from ${module("@aura/core")};
import { SettingsScreen } from ${source("../src/screens/Settings.tsx")};
import { SessionStatus } from ${source("../src/SessionStatus.tsx")};
import { conversationInfoStatus } from ${source("../src/features/coding/conversationStatus.ts")};
import { ToastProvider, useToast } from ${source("../src/toast.tsx")};
import { useAppearance } from ${source("../src/useAppearance.ts")};
import ${source("../src/styles.css")};
const titles = { "zh-CN": "示例插件", en: "Example plugin", ja: "サンプルプラグイン", ko: "예제 플러그인", ru: "Пример плагина", fr: "Exemple de plugin" };
registerCatalogs("plugin.example", Object.fromEntries(Object.entries(titles).map(([locale, title]) => [locale, { title }])));
let mounts = 0;
const cachedStatus = conversationInfoStatus({ lastTurnStatus: "running", waitingForAnswer: true });
let selectSection;
const requests = [];
globalThis.fetch = async input => { requests.push(String(input)); return Response.json({}, { status: 503 }); };
function Plugin() {
  const { t } = usePluginTranslation("example");
  const toast = useToast();
  React.useEffect(() => { mounts++; toast({ message: { namespace: "sidebar", key: "archivedNotice", values: { title: "My draft" } }, duration: 60000 }); }, [toast]);
  return React.createElement(React.Fragment, null,
    React.createElement("p", { id: "plugin-label" }, t("title")),
    React.createElement(SessionStatus, { status: cachedStatus, text: true }));
}
function Harness() {
  const appearance = useAppearance(true);
  const [section, setSection] = React.useState("connection");
  const [state, setState] = React.useState(initialState);
  selectSection = setSection;
  return React.createElement(React.Fragment, null,
    React.createElement(SettingsScreen, {
      appearance, workspace: { state, setState, busy: false },
      codexAuth: { status: { state: "signed_out", model: "fixture" }, endpoint: "https://synthetic.invalid", loading: false },
      systemReduced: false, section, onSectionChange: setSection,
      pluginSettingsPages: new Map(), onOpenPluginSettings() {}, onHistory() {}, onArchived() {},
    }), React.createElement(Plugin));
}
const root = createRoot(document.getElementById("root"));
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); };
async function inspect() {
  await language.ready;
  flushSync(() => root.render(React.createElement(LanguageProvider, null, React.createElement(ToastProvider, null, React.createElement(Harness)))));
  await settle();
  const input = document.getElementById("settings-endpoint");
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "http://unsaved.example:9000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => selectSection("appearance"));
  await settle();
  const snapshots = [];
  for (const locale of Object.keys(titles)) {
    const select = document.getElementById("settings-language");
    flushSync(() => { select.value = locale; select.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 20 && document.documentElement.lang !== locale; i++) await settle();
    for (const width of [1120, 360]) {
      document.getElementById("root").style.width = width + "px";
      await settle();
      const panel = document.querySelector(".settings-page");
      snapshots.push({ locale, width, lang: document.documentElement.lang,
        title: document.querySelector(".settings-nav h1").textContent,
        plugin: document.getElementById("plugin-label").textContent,
        status: document.querySelector(".session-execution-status").getAttribute("aria-label"),
        toast: document.querySelector(".toast > span").textContent,
        draft: document.getElementById("settings-endpoint").value,
        sameInput: document.getElementById("settings-endpoint") === input,
        overflow: panel.scrollWidth > panel.clientWidth,
      });
    }
  }
  document.getElementById("result").textContent = JSON.stringify({ snapshots, mounts, requests });
  root.unmount();
}
inspect().catch(error => { document.getElementById("result").textContent = JSON.stringify({ error: String(error) }); });
document.currentScript.remove();
`,
    );
    const output = join(directory, "bundle");
    await build({
      configFile: false,
      root: directory,
      logLevel: "error",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: output,
        minify: true,
        lib: {
          entry,
          formats: ["iife"],
          name: "LanguageFixture",
          fileName: "fixture",
        },
      },
    });
    const [script, css] = await Promise.all([
      readFile(join(output, "fixture.iife.js"), "utf8"),
      readFile(join(output, "fixture.css"), "utf8"),
    ]);
    const page = join(directory, "fixture.html");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}#root{display:flex;flex-direction:column;width:1120px;height:800px;container:workspace / inline-size}${css}</style></head><body><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(directory, "browser")}`,
        "--window-size=1400,1000",
        "--virtual-time-budget=8000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { timeout: 30_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "The browser returned language results");
    const result = JSON.parse(json) as {
      error?: string;
      mounts: number;
      requests: string[];
      snapshots: Array<{
        locale: string;
        width: number;
        lang: string;
        title: string;
        plugin: string;
        status: string;
        toast: string;
        draft: string;
        sameInput: boolean;
        overflow: boolean;
      }>;
    };
    assert.equal(result.error, undefined);
    assert.equal(result.mounts, 1);
    assert.deepEqual(result.requests, []);
    const expected: Record<string, [string, string]> = {
      "zh-CN": ["设置", "示例插件"],
      en: ["Settings", "Example plugin"],
      ja: ["設定", "サンプルプラグイン"],
      ko: ["설정", "예제 플러그인"],
      ru: ["Настройки", "Пример плагина"],
      fr: ["Paramètres", "Exemple de plugin"],
    };
    assert.equal(result.snapshots.length, 12);
    const statuses: Record<string, string> = {
      "zh-CN": "等待你的回答",
      en: "Waiting for your answer",
      ja: "回答を待っています",
      ko: "답변을 기다리는 중",
      ru: "Ожидание вашего ответа",
      fr: "En attente de votre réponse",
    };
    for (const snapshot of result.snapshots) {
      const label = `${snapshot.locale} at ${snapshot.width}px`;
      assert.equal(snapshot.lang, snapshot.locale, label);
      assert.equal(snapshot.title, expected[snapshot.locale]?.[0], label);
      assert.equal(snapshot.plugin, expected[snapshot.locale]?.[1], label);
      assert.equal(snapshot.status, statuses[snapshot.locale], label);
      assert.ok(snapshot.toast.includes("My draft"), label);
      assert.equal(
        snapshot.toast,
        result.snapshots.find((item) => item.locale === snapshot.locale)?.toast,
        label,
      );
      assert.equal(snapshot.draft, "http://unsaved.example:9000", label);
      assert.equal(snapshot.sameInput, true, label);
      assert.equal(snapshot.overflow, false, label);
    }
    assert.equal(new Set(result.snapshots.map((item) => item.toast)).size, 6);
  },
);
