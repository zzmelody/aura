import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArrowUp, Search, Square } from "lucide-react";
import { palettes } from "@aura/ui/theme";

const chrome =
  process.env.CHROME_BIN ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);

test(
  "host and plugin icons share line weights and tones while semantic and custom graphics retain their appearance",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check shared icon styles in Chrome"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "aura-icons-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const styles = await Promise.all([
      readFile(new URL(import.meta.resolve("@aura/ui/icons.css")), "utf8"),
      ...[
        "styles.css",
        "workspace-chrome.css",
        "features/coding/coding.css",
        "screens/studios.css",
      ].map((file) =>
        readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ),
    ]);
    const search = (id: string, className?: string) =>
      renderToStaticMarkup(createElement(Search, { id, className, size: 16 }));
    const fixture = join(temporary, "icons.html");
    await writeFile(
      fixture,
      `<!doctype html><style>${styles.join("\n")}</style>
      <main class="aura-root workbench" data-reduced="true" style="display:block">
      <button class="icon-control">${search("host")}</button>
      <div class="plugin-page-frame">${search("plugin", "aura-icon--muted aura-icon--sm")}</div>
      <div class="coding-tool-leading">${search("tool")}</div>
      ${search("studio", "studios-tile-icon")}
      <span class="coding-tool-state failed">${search("failure")}</span>
      <button class="primary-button">${search("primary")}</button>
      <button class="icon-control" disabled>${search("disabled")}</button>
      ${renderToStaticMarkup(createElement(ArrowUp, { id: "send", className: "aura-icon--emphasis" }))}
      ${renderToStaticMarkup(createElement(Square, { id: "stop", className: "aura-icon--filled", fill: "currentColor" }))}
      ${search("display", "aura-icon--display")}
      ${renderToStaticMarkup(createElement(Search, { id: "custom", className: "aura-icon--custom", strokeWidth: 3 }))}
      <svg id="chart" viewBox="0 0 100 100" stroke-width="5"><path stroke-width="0.5" d="M0 0L100 100"/></svg>
      <svg id="custom-svg" class="aura-icon aura-icon--secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12H22"/></svg>
      </main><div class="aura-modal">${search("modal")}</div><pre id="result"></pre><script>
      const root=document.querySelector('main'),results=[];
      const color=value=>{const span=document.createElement('span');span.style.color=value;root.append(span);const result=getComputedStyle(span).color;span.remove();return result;};
      for(const [theme,palette] of Object.entries(${JSON.stringify(palettes)})){
        for(const [key,value] of Object.entries(palette))root.style.setProperty('--'+key,value);
        const items={};
        for(const id of ['host','plugin','tool','studio','failure','primary','disabled','send','stop','display','custom','chart','custom-svg','modal']){
          const node=document.getElementById(id),style=getComputedStyle(node);
          items[id]={weight:parseFloat(style.strokeWidth),color:style.color,fill:style.fill,width:style.width,opacity:style.opacity,parentOpacity:getComputedStyle(node.parentElement).opacity};
        }
        results.push({theme,items,secondary:color(palette.secondary),muted:color(palette.muted),danger:color(palette.danger),primaryText:color(palette.primaryText),chartPath:getComputedStyle(document.querySelector('#chart path')).strokeWidth});
      }
      document.getElementById('result').textContent=JSON.stringify(results);
      </script>`,
    );
    const { stdout } = await promisify(execFile)(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-breakpad",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(temporary, "profile")}`,
        "--dump-dom",
        pathToFileURL(fixture).href,
      ],
      { timeout: 25_000, maxBuffer: 2_000_000 },
    );
    const serialized = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(serialized, "Chrome returns icon appearance measurements");
    interface Appearance {
      weight: number;
      color: string;
      fill: string;
      width: string;
      opacity: string;
      parentOpacity: string;
    }
    interface Measurement {
      theme: string;
      items: Record<string, Appearance>;
      secondary: string;
      muted: string;
      danger: string;
      primaryText: string;
      chartPath: string;
    }
    const results = JSON.parse(serialized) as Measurement[];
    assert.equal(results.length, 2);
    for (const result of results) {
      const { items } = result;
      for (const id of [
        "host",
        "plugin",
        "tool",
        "studio",
        "custom-svg",
        "modal",
      ])
        assert.equal(items[id]!.weight, 1.6, `${result.theme}: ${id}`);
      assert.equal(items.send!.weight, 1.8);
      assert.equal(items.display!.weight, 1.25);
      assert.equal(items.stop!.weight, 0);
      assert.equal(items.custom!.weight, 3);
      assert.equal(items.chart!.weight, 5);
      assert.equal(result.chartPath, "0.5px");
      assert.equal(items.host!.color, result.secondary);
      assert.equal(items.plugin!.color, result.muted);
      assert.equal(items["custom-svg"]!.color, result.secondary);
      assert.equal(items.failure!.color, result.danger);
      assert.equal(items.primary!.color, result.primaryText);
      assert.equal(items.plugin!.width, "14px");
      assert.equal(items.disabled!.opacity, "1", "Do not dim the icon twice");
      assert.equal(items.disabled!.parentOpacity, "0.45");
    }
  },
);
