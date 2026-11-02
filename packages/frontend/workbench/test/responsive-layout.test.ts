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
  "pages reflow when their pane narrows and recover when it widens without resizing the window",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check responsive layouts in Chrome"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "aura-responsive-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const styles = await Promise.all(
      [
        "styles.css",
        "workspace-chrome.css",
        "screens/feature-page.css",
        "screens/settings.css",
        "screens/automation.css",
        "screens/studios.css",
        "workflow-output.css",
      ].map((file) =>
        readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ),
    );
    const fixture = join(temporary, "responsive.html");
    await writeFile(
      fixture,
      `<!doctype html><style>${styles.join("\n")}
      .aura-root { display:block; } .workspace-main { height:700px; }
      .workspace-main > [hidden] { display:none; }
      </style><div class="aura-root workbench"><main class="workspace-main">
      <section id="settings" class="settings-page">
        <nav class="settings-nav"><h1>设置</h1><button>外观</button><button>模型与账号</button><button>会话记录</button></nav>
        <div class="settings-scroll"><div class="settings-content"><section>
          <div class="settings-themes"><button class="settings-theme"><span class="settings-theme-preview"></span><strong>夜航</strong></button><button class="settings-theme"><span class="settings-theme-preview"></span><strong>晨雾</strong></button></div>
          <div class="settings-form-grid"><label>服务<input></label><label>地址<input></label></div>
        </section></div></div>
      </section>
      <section id="workflows" class="workflow-library-page" hidden>
        <header class="workflow-page-heading"><div><h1>工作流</h1><p>选择并运行一个工作流</p></div><button>新建工作流</button></header>
        <div class="workflow-cards"><article class="workflow-card"><div class="workflow-card-summary">
          <button class="workflow-card-open"><span class="workflow-card-icon">F</span><span class="workflow-card-copy"><strong>示例工作流</strong><span>这是用于布局检查的合成数据</span></span></button>
          <div class="workflow-card-actions"><span class="workflow-card-status">可运行</span><button class="icon-control">E</button><button class="icon-control">R</button></div>
        </div></article></div>
        <form class="workflow-composer"><div class="workflow-input-fields"><label class="workflow-input-field">名称<input></label><label class="workflow-input-field">格式<select><option>GLB</option></select></label></div></form>
      </section>
      <section id="history" class="history-screen" hidden><div class="history-controls"><div class="history-filters"><button>全部</button><button>未归档</button><button>已归档</button></div><label class="history-search">⌕<input placeholder="搜索会话"></label></div></section>
      <section id="automation" class="automation-layout with-detail" hidden><div class="automation-page dsh-page"><h1>自动化任务</h1></div><aside class="automation-detail"><h2>合成任务详情</h2></aside></section>
      <section id="studios" class="dsh-page studios-page" hidden><ul class="studios-grid"><li><button class="studios-tile"><strong>合成插件入口</strong></button></li></ul></section>
      <section id="output" style="width:min(360px,100%)" hidden><div class="workflow-step-io"><div class="workflow-step-panel">输入</div><div class="workflow-step-panel">输出</div></div></section>
      </main></div><pre id="result"></pre><script>
      const main = document.querySelector("main");
      const box = selector => {
        const element = main.querySelector(selector);
        const rect = element.getBoundingClientRect();
        return { x:rect.x, y:rect.y, width:rect.width, bottom:rect.bottom, scroll:element.scrollWidth, client:element.clientWidth, display:getComputedStyle(element).display, direction:getComputedStyle(element).flexDirection };
      };
      const results = [];
      for (const width of [960, 720, 560, 320, 960]) {
        main.style.width = width + "px";
        const result = { width, viewport:innerWidth };
        for (const page of main.children) {
          for (const child of main.children) child.hidden = child !== page;
          if (page.id === "settings") result.settings = { nav:box(".settings-nav"), fields:[...page.querySelectorAll(".settings-form-grid label")].map(element => element.getBoundingClientRect().y) };
          if (page.id === "workflows") result.workflows = { open:box(".workflow-card-open"), actions:box(".workflow-card-actions"), fields:[...page.querySelectorAll(".workflow-input-field")].map(element => element.getBoundingClientRect().y) };
          if (page.id === "history") result.history = { filters:box(".history-filters"), search:box(".history-search"), page:box(".history-screen") };
          if (page.id === "automation") result.automation = { list:box(".automation-page"), detail:box(".automation-detail") };
          if (page.id === "studios") result.studios = box(".studios-grid");
          if (page.id === "output") result.output = [...page.querySelectorAll(".workflow-step-panel")].map(element => element.getBoundingClientRect().y);
        }
        results.push(result);
      }
      document.getElementById("result").textContent = JSON.stringify(results);
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
      { timeout: 25_000, maxBuffer: 2_000_000 },
    );
    const serialized = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(serialized, "Chrome must return its layout measurements");
    interface Box {
      y: number;
      bottom: number;
      width: number;
      display: string;
      direction: string;
      scroll: number;
      client: number;
    }
    interface Measurement {
      width: number;
      viewport: number;
      settings: { nav: Box; fields: number[] };
      workflows: { open: Box; actions: Box; fields: number[] };
      history: { filters: Box; search: Box; page: Box };
      automation: { list: Box; detail: Box };
      studios: Box;
      output: number[];
    }
    const results = JSON.parse(serialized) as Measurement[];
    for (const result of results) {
      assert.ok(result.viewport > 1200, "the window remains wide");
      assert.equal(
        result.settings.nav.direction,
        result.width <= 820 ? "row" : "column",
        `${result.width}px settings must follow pane width`,
      );
      assert.equal(
        result.settings.fields[0] === result.settings.fields[1],
        result.width > 600,
        `${result.width}px model fields must reflow`,
      );
      assert.equal(
        result.workflows.actions.y >= result.workflows.open.bottom,
        result.width <= 700,
        `${result.width}px workflow actions must reflow`,
      );
      assert.equal(
        result.workflows.fields[0] === result.workflows.fields[1],
        result.width > 700,
        `${result.width}px workflow inputs must reflow`,
      );
      if (result.width <= 820) {
        assert.equal(result.automation.list.display, "none");
        assert.ok(result.automation.detail.width >= result.width - 1);
      }
      if (result.width === 320)
        assert.ok(result.history.search.y >= result.history.filters.bottom);
      assert.ok(result.history.page.scroll <= result.history.page.client + 1);
      assert.ok(result.studios.scroll <= result.studios.client + 1);
      assert.ok(
        result.output[1] > result.output[0],
        "nested workflow results must stack in narrow panels even in a wide page",
      );
    }
  },
);
