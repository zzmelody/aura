import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";

const chrome = process.env.CHROME_BIN;

test(
  "Site switches six languages and expanded text without changing projects or restarting subscriptions",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check plugin language layouts"
        : false,
    timeout: 45_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-plugin-languages-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const require = createRequire(
      new URL("../packages/frontend/workbench/package.json", import.meta.url),
    );
    const module = (name: string) => JSON.stringify(require.resolve(name));
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
import { language, registerCatalogs, locales } from ${module("@aura/i18n/runtime")};
import { pseudolocalize } from ${module("@aura/i18n/catalogs")};
import { SiteScreen } from ${source("../plugins/site-launcher/client/src/SiteScreen.tsx")};
import { translations } from ${source("../plugins/site-launcher/client/src/messages.ts")};
import ${source("../plugins/site-launcher/client/src/site.css")};
registerCatalogs("plugin.site-launcher", translations);
window.auraHost = { platform: "desktop" };
let subscriptions = 0, cleanups = 0, calls = 0, writes = 0;
const project = { id: "synthetic", name: "My original project", directory: "C:/synthetic/project", packageManager: "pnpm", script: "dev", scripts: ["dev", "preview"], url: "http://127.0.0.1:9999" };
localStorage.setItem("aura.sites.v2", JSON.stringify([project]));
const originalSet = Storage.prototype.setItem;
Storage.prototype.setItem = function(...args) { writes++; return originalSet.apply(this,args); };
globalThis.fetch = async () => { calls++; throw new Error("No network in this fixture"); };
const operation = async () => { calls++; throw new Error("No project operations in this fixture"); };
const host = { chooseDirectory: operation, start: operation, stop: operation, open: operation,
  onStatus(callback) { subscriptions++; callback({ state: "error", project, pid: 42, previewReady: false,
    message: "legacy status",messageDetails:{code:"previewTimeout"},portMessage:"legacy port",
    portDetails:[{code:"portChanged",params:{preferred:9998,port:9999}},{code:"addressChanged",params:{url:project.url,previous:"http://localhost:9998/"}}],
    output:"Original process output / 原始日志",
  }); return () => { cleanups++; }; }
};
const root = createRoot(document.getElementById("root"));
const settle = async () => { await new Promise(resolve => setTimeout(resolve,0)); flushSync(() => {}); };
async function inspect() {
  await language.ready;
  flushSync(() => root.render(React.createElement(LanguageProvider, null, React.createElement(SiteScreen, { host }))));
  await settle(); await settle();
  const input = document.querySelector(".site-fields input"), stored = localStorage.getItem("aura.sites.v2");
  writes = 0;
  const snapshots = [];
  for (const variant of [...locales, "pseudo"]) {
    const locale = variant === "pseudo" ? "en" : variant;
    if (variant === "pseudo") registerCatalogs("plugin.site-launcher", { ...translations, en: pseudolocalize(translations.en) });
    await language.systemChanged([locale]); await settle();
    for (const width of [1120, 360, 320, 1120]) {
      document.getElementById("root").style.width = width + "px"; await settle();
      const page = document.querySelector(".site-page"), detail = document.querySelector(".site-detail");
      snapshots.push({ variant, width, headline: document.querySelector("h1").textContent,
        expected: variant === "pseudo" ? pseudolocalize(translations.en).headline : translations[locale].headline,
        overflow: page.scrollWidth > page.clientWidth + 1 || detail.scrollWidth > detail.clientWidth + 1,
        status: document.querySelector(".site-run-heading strong").textContent,
        message: document.querySelector(".site-run-body p").textContent,
        expectedMessage: language.i18n.t("previewTimeout",{ns:"plugin.site-launcher"}),
        port: document.querySelector(".site-port-message").textContent,
        expectedPort: language.i18n.t("portChanged",{ns:"plugin.site-launcher",preferred:9998,port:9999})+" "+language.i18n.t("addressChanged",{ns:"plugin.site-launcher",url:project.url,previous:"http://localhost:9998/"}),
        originalOutput: document.querySelector(".site-page").textContent.includes("Original process output / 原始日志"),
        sameInput: input === document.querySelector(".site-fields input"),
        value: input.value, name: document.querySelector(".site-detail h2").textContent,
      });
    }
  }
  const unchanged = localStorage.getItem("aura.sites.v2") === stored;
  root.unmount();
  document.getElementById("result").textContent = JSON.stringify({ snapshots, subscriptions, cleanups, calls, writes, unchanged });
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
          name: "PluginLanguages",
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
      `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}#root{display:flex;width:1120px;height:900px;--font-text:system-ui;--font-mono:monospace}${css}</style></head><body><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(directory, "browser")}`,
        "--window-size=1400,1100",
        "--virtual-time-budget=8000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { timeout: 30_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "The browser returned plugin language results");
    const result = JSON.parse(json) as {
      error?: string;
      subscriptions: number;
      cleanups: number;
      calls: number;
      writes: number;
      unchanged: boolean;
      snapshots: Array<{
        variant: string;
        width: number;
        headline: string;
        expected: string;
        overflow: boolean;
        status: string;
        message: string;
        expectedMessage: string;
        port: string;
        expectedPort: string;
        originalOutput: boolean;
        sameInput: boolean;
        value: string;
        name: string;
      }>;
    };
    assert.equal(result.error, undefined);
    assert.equal(result.subscriptions, 1);
    assert.equal(result.cleanups, 1);
    assert.equal(result.calls, 0);
    assert.equal(result.writes, 0);
    assert.equal(result.unchanged, true);
    assert.equal(result.snapshots.length, 28);
    for (const snapshot of result.snapshots) {
      const label = `${snapshot.variant} at ${snapshot.width}px`;
      assert.equal(snapshot.headline, snapshot.expected, label);
      assert.equal(snapshot.sameInput, true, label);
      assert.equal(snapshot.overflow, false, label);
      assert.equal(snapshot.value, "http://127.0.0.1:9999", label);
      assert.equal(snapshot.name, "My original project", label);
      assert.notEqual(snapshot.status, "running", label);
      assert.equal(snapshot.message, snapshot.expectedMessage, label);
      assert.equal(snapshot.port, snapshot.expectedPort, label);
      assert.equal(snapshot.originalOutput, true, label);
    }
  },
);
