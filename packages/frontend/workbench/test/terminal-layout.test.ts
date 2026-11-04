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
const run = promisify(execFile);

test(
  "terminal fills its panel and keeps a stable viewport during sidebar motion",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to run the browser layout regression"
        : false,
    timeout: 30_000,
  },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "aura-terminal-layout-"));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const styles = await Promise.all(
      [
        "styles.css",
        "shell.css",
        "workspace-chrome.css",
        "features/coding/coding.css",
        "features/coding/tools.css",
      ].map((file) =>
        readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ),
    );
    const fixture = join(temporary, "layout.html");
    await writeFile(
      fixture,
      `<!doctype html><html><head><style>${styles.join("\n")}</style></head>
<body class="workbench">
<div class="standalone" style="display:flex;height:600px">
  <div class="studio-area">
    <section class="coding-studio chat-screen studio-main">
      <div class="coding-panes" style="--coding-side-width:440px">
        <div class="coding-pane coding-main-column"></div>
        <div class="coding-split-handle"></div>
        <aside class="coding-side">
          <header class="coding-tools-header"><span>zsh</span></header>
          <section class="coding-terminal coding-pane">
            <div class="coding-terminal-screen"><div class="xterm"></div></div>
            <footer class="coding-terminal-footer">已连接</footer>
          </section>
        </aside>
      </div>
    </section>
  </div>
</div><pre id="result"></pre>
<script>
const host = document.querySelector('.standalone');
const panes = document.querySelector('.coding-panes');
const results = [];
for (const width of [375, 900, 1600, 2400]) {
  host.style.width = width + 'px';
  panes.toggleAttribute('data-stacked', width < 648);
  panes.toggleAttribute('data-tools-only', width < 648);
  document.querySelector('.coding-split-handle').hidden = width < 648;
  const rect = selector => {
    const box = document.querySelector(selector).getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, height: box.height };
  };
  results.push({width, workspace: rect('.coding-studio'), side: rect('.coding-side'),
    header: rect('.coding-tools-header'), terminal: rect('.coding-terminal'), screen: rect('.coding-terminal-screen')});
}
const motion = [];
for (const width of [375, 900]) {
  const narrow = width < 648;
  host.style.width = width + 'px';
  panes.toggleAttribute('data-stacked', narrow);
  panes.toggleAttribute('data-tools-only', narrow);
  panes.querySelector('.coding-split-handle').hidden = narrow;
  const side = panes.querySelector('.coding-side');
  const main = panes.querySelector('.coding-main-column');
  const screen = side.querySelector('.coding-terminal-screen');
  const geometry = () => ({
    sideStart: side.getBoundingClientRect().left,
    viewportWidth: screen.getBoundingClientRect().width,
    mainWidth: main.getBoundingClientRect().width,
    sideDisplay: getComputedStyle(side).display,
  });
  const opened = geometry();
  panes.dataset.sideClosed = '';
  delete panes.dataset.toolsOnly;
  const progress = panes.getAnimations().find(animation => animation instanceof CSSTransition);
  if (progress) {
    progress.pause();
    progress.currentTime = 90;
  }
  const leaving = geometry();
  document.body.dataset.reduced = 'true';
  const closed = geometry();
  delete panes.dataset.sideClosed;
  panes.toggleAttribute('data-tools-only', narrow);
  geometry();
  delete document.body.dataset.reduced;
  motion.push({ width, narrow, opened, leaving, closed });
}
document.querySelector('#result').textContent = JSON.stringify({ layouts: results, motion });
</script></body></html>`,
    );
    const { stdout } = await run(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-breakpad",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(temporary, "profile")}`,
        "--window-size=2600,800",
        "--dump-dom",
        pathToFileURL(fixture).href,
      ],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000 },
    );
    const result = stdout.match(/<pre id="result">([^<]+)<\/pre>/);
    assert.ok(result, "Chrome should return measured panel dimensions");
    type Box = { left: number; right: number; width: number; height: number };
    type Layout = {
      width: number;
      workspace: Box;
      side: Box;
      header: Box;
      terminal: Box;
      screen: Box;
    };
    type MotionBox = {
      sideStart: number;
      viewportWidth: number;
      mainWidth: number;
      sideDisplay: string;
    };
    const { layouts, motion } = JSON.parse(result[1]!) as {
      layouts: Layout[];
      motion: Array<{
        width: number;
        narrow: boolean;
        opened: MotionBox;
        leaving: MotionBox;
        closed: MotionBox;
      }>;
    };
    assert.equal(layouts.length, 4);
    for (const layout of layouts) {
      assert.equal(
        layout.workspace.width,
        layout.width,
        `Workspace must fill ${layout.width}px without loading the demo chat`,
      );
      assert.equal(layout.side.right, layout.workspace.right);
      for (const box of [layout.header, layout.terminal, layout.screen]) {
        assert.equal(box.left, layout.side.left);
        assert.equal(box.right, layout.side.right);
      }
      assert.ok(layout.screen.height > 500, "Terminal fills available height");
      if (layout.width < 648)
        assert.equal(layout.side.width, layout.workspace.width);
    }
    assert.equal(motion.length, 2);
    for (const { width, narrow, opened, leaving, closed } of motion) {
      assert.equal(leaving.viewportWidth, opened.viewportWidth);
      assert.ok(
        leaving.sideStart > opened.sideStart && leaving.sideStart < width,
      );
      assert.equal(leaving.sideDisplay, "flex");
      assert.equal(closed.sideDisplay, "none");
      assert.equal(closed.mainWidth, width);
      if (narrow) assert.equal(leaving.mainWidth, width);
      else
        assert.ok(
          leaving.mainWidth > opened.mainWidth && leaving.mainWidth < width,
        );
    }
  },
);
