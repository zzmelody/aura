import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";

const chrome =
  process.env.CHROME_BIN ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);

test(
  "settings show one page, load visited pages and preserve drafts across category changes",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check settings navigation in Chrome"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-settings-pages-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entry = join(root, "fixture.ts");
    // Synthetic, read-only responses isolate the real settings UI from accounts,
    // credentials and any running Aura service.
    await writeFile(
      entry,
      `import React from ${JSON.stringify(fileURLToPath(import.meta.resolve("react")))};
import { createRoot } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom/client")))};
import { flushSync } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom")))};
import { initialState } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@aura/core")))};
import { palettes } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@aura/ui/theme")))};
import { SettingsScreen } from ${JSON.stringify(fileURLToPath(new URL("../src/screens/Settings.tsx", import.meta.url)))};
import { useAppearance } from ${JSON.stringify(fileURLToPath(new URL("../src/useAppearance.ts", import.meta.url)))};
import { language } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@aura/i18n/runtime")))};
const requests = [];
globalThis.fetch = async (input, options) => {
  const path = new URL(String(input)).pathname;
  requests.push({ path, method: options?.method ?? "GET" });
  if (path === "/plugins/config") return Response.json({ plugins: [], active: [], applyRequired: false, configPath: "synthetic" });
  if (path === "/ai/services") return Response.json({
    model: { model: "synthetic", reasoningEffort: "off", configured: false, hasKey: false },
    customModel: { model: "synthetic", reasoningEffort: "off", hasKey: false, custom: { name: "Saved name", api: "openai-completions", baseURL: "https://synthetic.example/v1", contextWindow: 8192, images: true } },
    lumina: { model: "synthetic", reasoningEffort: "off", baseURL: "https://synthetic.example/v1", hasKey: false, readOnly: false, modelCount: 0 },
    checks: { model: "未检查", lumina: "未检查" },
  });
  if (path === "/integrations/settings") return Response.json({
    flags: { mcp: false, voice: false, market: false, browser: false },
    mcpServers: [], voicePhase: "unavailable",
  });
  return Response.json({ message: "Unavailable in this synthetic fixture" }, { status: 503 });
};
let selectPage;
function Harness() {
  const appearance = useAppearance(true);
  const [section, setSection] = React.useState("appearance");
  const [state, setState] = React.useState(() => ({ ...initialState(), endpoint: "https://synthetic.example" }));
  selectPage = setSection;
  return React.createElement(SettingsScreen, {
    appearance,
    workspace: { state, setState, busy: false },
    codexAuth: { status: { state: "signed_out", model: "synthetic" }, loading: false, endpoint: state.endpoint },
    systemReduced: false, section, onSectionChange: setSection,
    pluginSettingsPages: new Map(), onOpenPluginSettings() {}, onHistory() {}, onArchived() {},
  });
}
for (const [name, value] of Object.entries(palettes.dark)) document.documentElement.style.setProperty("--" + name, value);
const mount = document.getElementById("root");
const root = createRoot(mount);
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); };
const snapshots = [];
const capture = (label) => {
  const pages = [...document.querySelectorAll(".settings-content > section")];
  const nav = document.querySelector(".settings-nav").getBoundingClientRect();
  const selected = document.querySelector('.settings-nav [aria-current="page"]');
  const button = selected.getBoundingClientRect();
  snapshots.push({
    label,
    visible: pages.filter(page => getComputedStyle(page).display !== "none").map(page => page.id),
    current: selected.textContent,
    currentInView: button.left >= nav.left && button.right <= nav.right,
    scroll: document.querySelector(".settings-scroll").scrollTop,
    overflow: document.querySelector(".settings-page").scrollWidth > mount.clientWidth,
    nav: getComputedStyle(document.querySelector(".settings-nav")).flexDirection,
  });
};
const choose = async (label) => {
  const button = [...document.querySelectorAll(".settings-nav button")].find(item => item.textContent === label);
  flushSync(() => button.click());
  await settle();
  capture(label);
};
const edit = (input, value) => flushSync(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
async function inspect() {
  await language.systemChanged(["zh-CN"]);
  flushSync(() => root.render(React.createElement(Harness)));
  await settle();
  capture("initial");
  const unopenedRequests = requests.length;
  await choose("模型与账号");
  const name = document.querySelector('input[placeholder="我的 API"]');
  for (let attempt = 0; attempt < 50 && name.value !== "Saved name"; attempt++) await settle();
  edit(name, "Unsaved model name");
  await settle();
  const modelReads = requests.filter(request => request.path === "/ai/services").length;
  const scroller = document.querySelector(".settings-scroll");
  scroller.scrollTop = 1000;
  const longPageScrolled = scroller.scrollTop > 0;
  scroller.dispatchEvent(new Event("scroll"));
  capture("scrolled-models");
  await choose("连接");
  const address = document.getElementById("settings-endpoint");
  edit(address, "http://unsaved.example:9000");
  await choose("插件");
  await choose("模型与账号");
  const modelDraft = document.querySelector('input[placeholder="我的 API"]').value;
  const repeatedModelReads = requests.filter(request => request.path === "/ai/services").length;
  await choose("连接");
  const connectionDraft = document.getElementById("settings-endpoint").value;
  await choose("功能开关");
  await choose("会话记录");
  await choose("关于");
  address.focus();
  const hiddenFieldFocused = document.activeElement === address;
  for (const width of [600, 375, 1120]) {
    mount.style.width = width + "px";
    await choose("外观");
    capture("width-" + width);
    await choose("插件");
  }
  flushSync(() => selectPage("records"));
  await settle();
  capture("shortcut-records");
  document.getElementById("result").textContent = JSON.stringify({ snapshots, unopenedRequests, modelReads, repeatedModelReads, longPageScrolled, modelDraft, connectionDraft, hiddenFieldFocused, requests });
  root.unmount();
}
inspect().catch(error => { document.getElementById("result").textContent = JSON.stringify({ error: String(error) }); });
document.currentScript.remove();
`,
    );
    const output = join(root, "bundle");
    await build({
      configFile: false,
      root,
      logLevel: "error",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: output,
        minify: true,
        lib: {
          entry,
          formats: ["iife"],
          name: "SettingsFixture",
          fileName: "fixture",
        },
      },
    });
    const [script, css] = await Promise.all([
      readFile(join(output, "fixture.iife.js"), "utf8"),
      readFile(join(output, "fixture.css"), "utf8"),
    ]);
    const page = join(root, "fixture.html");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}#root{display:flex;width:1120px;height:560px;container:workspace / inline-size}${css}</style></head><body><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(root, "chrome")}`,
        "--window-size=1400,900",
        "--virtual-time-budget=5000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "Chrome must return the settings navigation results");
    const result = JSON.parse(json) as {
      error?: string;
      snapshots: Array<{
        label: string;
        visible: string[];
        current: string;
        currentInView: boolean;
        scroll: number;
        overflow: boolean;
        nav: string;
      }>;
      unopenedRequests: number;
      modelReads: number;
      repeatedModelReads: number;
      longPageScrolled: boolean;
      modelDraft: string;
      connectionDraft: string;
      hiddenFieldFocused: boolean;
      requests: Array<{ path: string; method: string }>;
    };
    assert.equal(result.error, undefined);
    const pageIds: Record<string, string> = {
      initial: "appearance",
      外观: "appearance",
      模型与账号: "models",
      连接: "connection",
      功能开关: "features",
      插件: "plugins",
      会话记录: "records",
      关于: "about",
      "scrolled-models": "models",
      "shortcut-records": "records",
    };
    for (const snapshot of result.snapshots) {
      const id = pageIds[snapshot.label] ?? "appearance";
      assert.deepEqual(snapshot.visible, [`settings-${id}`], snapshot.label);
      assert.ok(snapshot.current, "A current settings page must be announced");
      assert.equal(snapshot.currentInView, true, snapshot.label);
      assert.equal(snapshot.overflow, false, snapshot.label);
      if (snapshot.label !== "scrolled-models")
        assert.equal(snapshot.scroll, 0, snapshot.label);
      if (snapshot.label.startsWith("width-"))
        assert.equal(
          snapshot.nav,
          Number(snapshot.label.slice(6)) <= 820 ? "row" : "column",
        );
    }
    assert.equal(result.unopenedRequests, 0);
    assert.equal(result.modelReads, 1);
    assert.equal(result.repeatedModelReads, 1);
    assert.equal(result.longPageScrolled, true);
    assert.equal(result.modelDraft, "Unsaved model name");
    assert.equal(result.connectionDraft, "http://unsaved.example:9000");
    assert.equal(result.hiddenFieldFocused, false);
    assert.ok(result.requests.every(({ method }) => method === "GET"));
  },
);
