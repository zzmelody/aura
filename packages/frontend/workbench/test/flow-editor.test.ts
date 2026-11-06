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
  "Agent SVG diagrams stay paired with their source and both editor panels remain visible",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to run the Flow editor browser regression"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-flow-editor-"));
    t.after(() => rm(root, { recursive: true, force: true }));
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
          entry: fileURLToPath(
            new URL("./fixtures/flow-editor.ts", import.meta.url),
          ),
          formats: ["iife"],
          name: "FlowEditorFixture",
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
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}*{box-sizing:border-box}body{margin:0;background:#111114}#root{display:flex;width:1120px;height:760px;--background:#111114;--surface:#242428;--text:#ededf0;--muted:#aaa;--accent:#bda1ff;--border:#595961;--font-text:system-ui;--font-mono:monospace;--workspace-sidebar-duration:0ms}.workspace-deck{width:100%;height:100%}</style></head><body class="workbench"><div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
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
    assert.ok(json, "Browser must return the Flow editor verification results");
    const result = JSON.parse(
      json
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&"),
    ) as { checks: string[]; error?: string };
    assert.equal(
      result.error,
      undefined,
      `${result.error}\n${result.checks.join("\n")}`,
    );
    assert.ok(result.checks.length >= 30);
  },
);
