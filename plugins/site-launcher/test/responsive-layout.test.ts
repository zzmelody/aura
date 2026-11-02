import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const chrome =
  process.env.CHROME_BIN ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);

test(
  "the site page reflows with its host area while the browser stays wide",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check the Site layout in Chrome"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "aura-site-layout-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const css = await readFile(
      new URL("../client/src/site.css", import.meta.url),
      "utf8",
    );
    const fixture = join(temporary, "site.html");
    await writeFile(
      fixture,
      `<!doctype html><style>*{box-sizing:border-box}body{margin:0}${css}</style>
      <main><section class="site-page"><div class="site-page-inner">
      <header class="site-hero site-hero-compact"><div class="site-hero-copy"><h1>本地站点，一处管理。</h1><p>此页使用合成项目检查布局，不启动进程。</p></div><div class="site-hero-stats"><strong>02</strong><span>已保存项目</span></div></header>
      <div class="site-console"><aside class="site-project-list"><button>合成项目</button></aside><div class="site-detail"><div class="site-detail-grid"><div>配置</div><div>运行状态</div></div></div></div>
      </div></section></main><pre id="result"></pre><script>
      const root=document.querySelector("main"), results=[];
      const box=selector=>{const node=document.querySelector(selector), rect=node.getBoundingClientRect();return {y:rect.y,bottom:rect.bottom,scroll:node.scrollWidth,client:node.clientWidth};};
      for(const width of [960,720,560,320,960]){
        root.style.width=width+"px";
        results.push({width,viewport:innerWidth,list:box(".site-project-list"),detail:box(".site-detail"),copy:box(".site-hero-copy"),stats:box(".site-hero-stats"),page:box(".site-page"),panels:[...document.querySelector(".site-detail-grid").children].map(node=>node.getBoundingClientRect().y)});
      }
      document.getElementById("result").textContent=JSON.stringify(results);
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
        "--window-size=1400,1000",
        "--dump-dom",
        pathToFileURL(fixture).href,
      ],
      { timeout: 25_000, maxBuffer: 1_000_000 },
    );
    const serialized = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(serialized, "Chrome must return the measured Site layout");
    interface Box {
      y: number;
      bottom: number;
      scroll: number;
      client: number;
    }
    interface Measurement {
      width: number;
      viewport: number;
      list: Box;
      detail: Box;
      copy: Box;
      stats: Box;
      page: Box;
      panels: number[];
    }
    const results = JSON.parse(serialized) as Measurement[];
    for (const result of results) {
      assert.ok(result.viewport > 1200);
      assert.equal(
        result.detail.y >= result.list.bottom,
        result.width <= 720,
        `${result.width}px project list must stack above the detail`,
      );
      assert.equal(result.panels[0] === result.panels[1], result.width > 720);
      if (result.width === 320) assert.ok(result.stats.y >= result.copy.bottom);
      assert.ok(result.page.scroll <= result.page.client + 1);
    }
  },
);
