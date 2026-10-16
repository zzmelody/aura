import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const defaultChrome =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined;
const chrome = process.env.CHROME_BIN ?? defaultChrome;
const run = promisify(execFile);

// This is a browser layout regression, not a source-text assertion. Other hosts
// can opt in with CHROME_BIN without adding a browser automation dependency.
test(
  "long code, tables and expanded diffs stay inside each conversation",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to run the browser layout regression"
        : false,
    timeout: 30_000,
  },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "aura-coding-width-"));
    context.after(async () => {
      assert.equal(dirname(temporary), tmpdir());
      assert.match(basename(temporary), /^aura-coding-width-/);
      await rm(temporary, { recursive: true, force: true });
    });
    const styles = await Promise.all(
      ["styles.css", "shell.css", "features/coding/coding.css"].map((file) =>
        readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ),
    );
    const line = `const value = "${"unbroken-code-".repeat(150)}";`;
    const code = `<pre><code>${line}</code></pre>`;
    const table = `<div class="workflow-table-scroll"><table><tr>${"<th>Long table heading</th>".repeat(12)}</tr><tr>${"<td>Long table content</td>".repeat(12)}</tr></table></div>`;
    const diff = `<div class="coding-diffs"><div class="coding-diff"><pre><span class="coding-diff-line add">${line}</span></pre></div></div>`;
    const fixture = join(temporary, "layout.html");
    await writeFile(
      fixture,
      `<!doctype html><html><head><style>${styles.join("\n")}</style></head>
<body><div class="coding-panes" style="height:800px"></div><pre id="layout-result"></pre>
<script>
const root = document.querySelector(".coding-panes");
const results = [];
const pane = (content) => '<div class="coding-pane"><div class="studio-scroll coding-transcript"><article class="coding-turn"><div class="coding-prompt">检查长内容</div><div class="coding-reply"><div class="workflow-rich-text">' + content + '</div></div><section class="coding-recap">本轮小结</section></article></div></div>';
for (const content of ${JSON.stringify([code, table, code + table, diff])}) {
  for (const width of [1200, 920, 700, 648, 600, 375])
  for (const stale of [false, true]) {
    const stacked = width < 648;
    root.style.width = width + 'px';
    // A stale saved width (e.g. before the window shrank) must still fit.
    root.style.setProperty('--coding-side-width', (stale ? 2000 : Math.min(440, width - 328)) + 'px');
    root.toggleAttribute('data-stacked', stacked);
    root.innerHTML = pane(content) + (stacked ? '' : '<div class="coding-split-handle"></div>') + '<aside class="coding-side">' + pane(content) + '</aside>';
    const transcripts = Array.from(root.querySelectorAll('.coding-transcript'));
    const blocks = Array.from(root.querySelectorAll('.workflow-rich-text pre, .workflow-table-scroll, .coding-diff pre'));
    results.push({
      width,
      stacked,
      root: { client: root.clientWidth, scroll: root.scrollWidth },
      panes: Array.from(root.children).filter(node => !node.classList.contains('coding-split-handle')).map(node => node.getBoundingClientRect().width),
      transcripts: transcripts.map(node => ({ client: node.clientWidth, scroll: node.scrollWidth })),
      blocks: blocks.map(node => ({ client: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).overflowX })),
      turns: Array.from(root.querySelectorAll('.coding-turn')).map(node => ({ width: node.getBoundingClientRect().width, children: Array.from(node.children).map(child => child.getBoundingClientRect().width) })),
    });
  }
}
document.getElementById('layout-result').textContent = JSON.stringify(results);
</script></body></html>`,
    );
    const { stdout } = await run(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        // Like browser automation runners, avoid nesting Chrome's OS sandbox
        // inside a sandboxed test process; only this local fixture is loaded.
        "--no-sandbox",
        "--disable-breakpad",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(temporary, "profile")}`,
        "--window-size=1600,1000",
        "--dump-dom",
        pathToFileURL(fixture).href,
      ],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const result = stdout.match(/<pre id="layout-result">([^<]+)<\/pre>/);
    assert.ok(result, "Chrome should return measured layout results");
    const layouts = JSON.parse(result[1]!) as Array<{
      width: number;
      stacked: boolean;
      root: { client: number; scroll: number };
      panes: number[];
      transcripts: Array<{ client: number; scroll: number }>;
      blocks: Array<{ client: number; scroll: number; overflow: string }>;
      turns: Array<{ width: number; children: number[] }>;
    }>;
    assert.equal(layouts.length, 48);
    for (const layout of layouts) {
      assert.ok(
        layout.root.scroll <= layout.root.client + 1,
        `At ${layout.width}px, the split overflowed to ${layout.root.scroll}px`,
      );
      if (!layout.stacked)
        for (const pane of layout.panes)
          assert.ok(
            pane >= 319,
            `At ${layout.width}px, a pane shrank to ${pane}px`,
          );
      for (const transcript of layout.transcripts)
        assert.ok(
          transcript.scroll <= transcript.client + 1,
          `At ${layout.width}px, transcript overflowed to ${transcript.scroll}px inside ${transcript.client}px`,
        );
      for (const turn of layout.turns)
        for (const child of turn.children)
          assert.ok(
            child <= turn.width + 1,
            "Turn children must fit its column",
          );
      for (const block of layout.blocks) {
        assert.ok(block.scroll > block.client, "Keep wide content available");
        assert.equal(
          block.overflow,
          "auto",
          "Scroll only inside the wide block",
        );
      }
    }
  },
);
