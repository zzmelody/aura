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

const chrome = process.env.CHROME_BIN;

test(
  "appearance controls apply across shared components and portals, survive remount and reset independently",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check appearance in Chrome/Chromium"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-appearance-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modulePath = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const entry = join(root, "fixture.ts");
    await writeFile(
      entry,
      `
import React from ${JSON.stringify(fileURLToPath(import.meta.resolve("react")))};
import { createRoot } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom/client")))};
import { flushSync } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom")))};
import { Button, ThemeContext } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@aura/ui/components")))};
import { Modal } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@aura/ui/web")))};
import { AppearanceSettings } from ${modulePath("../src/screens/AppearanceSettings.tsx")};
import { useAppearance } from ${modulePath("../src/useAppearance.ts")};
import { language } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@aura/i18n/runtime")))};
import ${modulePath("../src/styles.css")};
import ${modulePath("../src/screens/settings.css")};
// Synthetic storage never reads or writes the user's browser profile.
const stored = new Map([["aura.workspace.v1", "keep workspace"], ["aura.coding.side-width", "450"]]);
const writes = [];
let blocked = false;
Object.defineProperty(window, "localStorage", { value: {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => { if (blocked) throw Error("Storage full"); writes.push(key); stored.set(key, value); },
  removeItem: key => { if (blocked) throw Error("Storage blocked"); writes.push(key); stored.delete(key); },
} });
let current;
let setDark;
function Harness() {
  const [dark, changeDark] = React.useState(true);
  const appearance = useAppearance(dark);
  current = appearance;
  setDark = changeDark;
  return React.createElement(ThemeContext.Provider, { value: { colors: appearance.colors, dark, reduced: true } },
    React.createElement("div", { className: "aura-root workbench settings-scroll", "data-reduced": true },
      React.createElement(AppearanceSettings, { appearance }),
      React.createElement("code", { id: "code", style: { fontFamily: "var(--font-mono)" } }, "const aura = true;"),
      React.createElement(Modal, { visible: true },
        React.createElement("div", { id: "portal" }, React.createElement(Button, { onPress() {} }, "弹窗按钮"))),
    ),
  );
}
const mount = document.getElementById("root");
let renderer = createRoot(mount);
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); };
const snapshots = [];
const snapshot = (phase) => {
  const sample = document.querySelector(".settings-appearance-preview");
  snapshots.push({ phase, preferences: current.preferences, colors: current.colors,
    sampleFont: getComputedStyle(sample).fontFamily,
    portalFont: getComputedStyle(document.querySelector("#portal .aura-button span")).fontFamily,
    codeFont: getComputedStyle(document.getElementById("code")).fontFamily,
    radius: getComputedStyle(sample).borderTopLeftRadius,
    portalRadius: getComputedStyle(document.querySelector("#portal .aura-button")).borderTopLeftRadius,
    saveError: current.saveError,
  });
};
const click = async (selector) => { flushSync(() => document.querySelector(selector).click()); await settle(); };
const chooseFont = async value => {
  flushSync(() => {
    const select = document.getElementById("appearance-font");
    select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};
const editHex = async value => {
  const input = document.querySelector('[aria-label="强调色 HEX"]');
  input.focus();
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => input.blur());
  await settle();
};
async function inspect() {
  await language.systemChanged(["zh-CN"]);
  flushSync(() => renderer.render(React.createElement(Harness)));
  await settle();
  const initialWrites = writes.length;
  snapshot("default");
  await click('[aria-label="青绿"]');
  await chooseFont("serif");
  await click('.settings-radius-options button:first-child');
  snapshot("square");
  await click('.settings-radius-options button:last-child');
  snapshot("rounded");
  const colorInput = document.querySelector('[aria-label="自选强调色"]');
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(colorInput, "#3b82f6");
    colorInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  snapshot("picker");
  await editHex("#oops");
  const invalidRejected = current.preferences.accent === "#3B82F6" && document.querySelector('[aria-label="强调色 HEX"]').getAttribute("aria-invalid") === "true";
  await editHex("#ff33aa");
  snapshot("hex");
  flushSync(() => setDark(false));
  await settle();
  snapshot("light");
  flushSync(() => renderer.unmount());
  renderer = createRoot(mount);
  flushSync(() => renderer.render(React.createElement(Harness)));
  await settle();
  snapshot("restored");
  const widths = [];
  for (const width of [700, 320, 700]) {
    mount.style.width = width + "px";
    await settle();
    const panel = document.querySelector(".settings-custom-appearance");
    const font = document.getElementById("appearance-font");
    widths.push({ width, overflow: panel.scrollWidth > panel.clientWidth,
      fontStacked: font.getBoundingClientRect().top >= font.previousElementSibling.getBoundingClientRect().bottom,
    });
  }
  await click('.settings-appearance-head button');
  snapshot("reset");
  const resetValues = [...stored];
  const resetDisabled = document.querySelector('.settings-appearance-head button').disabled;
  blocked = true;
  await click('[aria-label="玫瑰"]');
  snapshot("blocked");
  const errorAnnounced = Boolean(document.querySelector('[role="alert"]'));
  document.getElementById("result").textContent = JSON.stringify({ snapshots, initialWrites, writes, invalidRejected, widths, resetValues, resetDisabled, errorAnnounced });
  renderer.unmount();
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
          name: "AppearanceFixture",
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
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}#root{width:700px}.settings-scroll{padding:20px}#portal{pointer-events:none}</style></head><body><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(root, "chrome")}`,
        "--window-size=1200,900",
        "--virtual-time-budget=5000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, "The browser must return the appearance results");
    const result = JSON.parse(json) as {
      error?: string;
      initialWrites: number;
      writes: string[];
      invalidRejected: boolean;
      widths: Array<{ width: number; overflow: boolean; fontStacked: boolean }>;
      resetValues: Array<[string, string]>;
      resetDisabled: boolean;
      errorAnnounced: boolean;
      snapshots: Array<{
        phase: string;
        preferences: { accent: string | null; font: string; radius: string };
        colors: { primary: string; accent: string };
        sampleFont: string;
        portalFont: string;
        codeFont: string;
        radius: string;
        portalRadius: string;
        saveError: boolean;
      }>;
    };
    assert.equal(result.error, undefined);
    const phase = (name: string) =>
      result.snapshots.find((item) => item.phase === name)!;
    assert.equal(result.initialWrites, 0);
    assert.equal(phase("square").preferences.accent, "#14B8A6");
    assert.match(phase("square").sampleFont, /Songti/);
    assert.equal(phase("square").portalFont, phase("square").sampleFont);
    assert.equal(phase("square").codeFont, phase("default").codeFont);
    assert.equal(phase("square").radius, "0px");
    assert.equal(phase("square").portalRadius, "0px");
    assert.equal(phase("rounded").radius, "24px");
    assert.equal(phase("rounded").portalRadius, "12px");
    assert.equal(phase("picker").preferences.accent, "#3B82F6");
    assert.equal(result.invalidRejected, true);
    assert.equal(phase("hex").preferences.accent, "#FF33AA");
    assert.notEqual(phase("light").colors.accent, phase("hex").colors.accent);
    assert.deepEqual(phase("light").preferences, phase("hex").preferences);
    assert.deepEqual(phase("restored").preferences, phase("hex").preferences);
    assert.deepEqual(phase("reset").preferences, phase("default").preferences);
    assert.deepEqual(phase("reset").colors, phase("default").colors);
    assert.equal(phase("reset").radius, phase("default").radius);
    assert.equal(phase("reset").portalFont, phase("default").portalFont);
    assert.equal(result.resetDisabled, true);
    assert.deepEqual(result.resetValues, [
      ["aura.workspace.v1", "keep workspace"],
      ["aura.coding.side-width", "450"],
    ]);
    assert.ok(result.writes.every((key) => key === "aura.appearance.v1"));
    assert.ok(result.widths.every(({ overflow }) => !overflow));
    assert.deepEqual(
      result.widths.map(({ fontStacked }) => fontStacked),
      [false, true, false],
    );
    assert.equal(phase("blocked").preferences.accent, "#F43F5E");
    assert.equal(phase("blocked").saveError, true);
    assert.equal(result.errorAnnounced, true);
  },
);
