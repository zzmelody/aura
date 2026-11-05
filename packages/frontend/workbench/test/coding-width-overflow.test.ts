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
  "conversation content, file actions, approval and input stay bounded around long paths, code, tables and diffs",
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
      [
        "styles.css",
        "shell.css",
        "features/coding/coding.css",
        "features/coding/composer.css",
        "screens/chat-model-controls.css",
      ].map((file) =>
        readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ),
    );
    const line = `const value = "${"unbroken-code-".repeat(150)}";`;
    const code = `<pre><code>${line}</code></pre>`;
    const table = `<div class="workflow-table-scroll"><table><tr>${"<th>Long table heading</th>".repeat(12)}</tr><tr>${"<td>Long table content</td>".repeat(12)}</tr></table></div>`;
    const diff = `<div class="coding-diffs"><div class="coding-diff"><pre><span class="coding-diff-line add">${line}</span></pre></div></div>`;
    const paths = [
      "image.png",
      "/Users/example/workspace/aura/.aura/local-ai/outputs/gpt-73cf12b5027608cb/image.png",
      `${"long-filename".repeat(50)}.png`,
      ["C:", "Users", "example", "嵌套目录".repeat(20), "image.png"].join("\\"),
    ];
    const notes = [
      "",
      "已复制",
      "文件不存在或已被移动。",
      "很长的操作失败提示".repeat(40),
    ];
    const report = `<section class="coding-report" aria-label="交付文件"><h3>交付文件</h3><ul>${paths
      .map(
        (path, index) =>
          `<li><svg width="13" height="13"></svg><code title="${path}">${path}</code><span class="coding-report-actions"><button class="icon-control" aria-label="复制完整路径"><svg width="13" height="13"></svg></button><button class="icon-control" aria-label="在文件夹中显示"><svg width="13" height="13"></svg></button></span>${notes[index] ? `<span class="coding-report-note" role="status">${notes[index]}</span>` : ""}</li>`,
      )
      .join("")}</ul></section>`;
    const fixture = join(temporary, "layout.html");
    await writeFile(
      fixture,
      `<!doctype html><html><head><style>${styles.join("\n")}</style></head>
<body class="workbench standalone" style="display:block"><main class="studio-area"><section class="coding-studio chat-screen studio-main"><div class="coding-panes" style="height:800px"></div></section></main><pre id="layout-result"></pre>
<script>
const root = document.querySelector(".coding-panes");
const host = document.querySelector(".studio-area");
const results = [];
const pane = (content) => '<div class="coding-pane"><div class="studio-scroll coding-transcript"><article class="coding-turn"><div class="coding-prompt">检查长内容</div><div class="coding-reply"><div class="workflow-rich-text">' + content + '</div></div>' + ${JSON.stringify(report)} + '<section class="coding-recap">本轮小结</section></article></div><div class="chat-composer-area"><div class="coding-decision approval"><div class="coding-decision-strip">等待审批</div><div class="coding-decision-body">允许运行构建吗？</div><div class="coding-decision-actions"><button>拒绝</button><button>允许这一次</button></div></div><div class="chat-composer"><textarea>检查宽度</textarea><div class="composer-tools coding-composer-tools"><div class="composer-leading"><button class="icon-control composer-add-trigger">+</button></div><div class="composer-trailing"><div class="chat-model-picker"><button class="chat-model-trigger"><span class="chat-model-name">a-very-long-model-name</span><span class="chat-model-effort">High</span></button></div><button class="icon-control composer-stop">■</button><button class="send-button">↑</button></div></div></div></div></div>';
for (const content of ${JSON.stringify([code, table, code + table, diff])}) {
  for (const width of [1920, 1600, 1200, 920, 700, 648, 600, 375])
  for (const stale of [false, true]) {
    const stacked = width < 648;
    host.style.width = width + 'px';
    // A stale saved width (e.g. before the window shrank) must still fit.
    root.style.setProperty('--coding-side-width', (stale ? 2000 : Math.min(440, width - 328)) + 'px');
    root.toggleAttribute('data-stacked', stacked);
    root.innerHTML = pane(content) + (stacked ? '' : '<div class="coding-split-handle"></div>') + '<aside class="coding-side">' + pane(content) + '</aside>';
    const transcripts = Array.from(root.querySelectorAll('.coding-transcript'));
    const blocks = Array.from(root.querySelectorAll('.workflow-rich-text pre, .workflow-table-scroll, .coding-diff pre'));
    results.push({
      width,
      stacked,
      frame: { left: root.getBoundingClientRect().left, right: root.getBoundingClientRect().right, hostLeft: host.getBoundingClientRect().left, hostRight: host.getBoundingClientRect().right },
      root: { client: root.clientWidth, scroll: root.scrollWidth },
      panes: Array.from(root.children).filter(node => !node.classList.contains('coding-split-handle')).map(node => node.getBoundingClientRect().width),
      transcripts: transcripts.map(node => ({ client: node.clientWidth, scroll: node.scrollWidth, right: node.getBoundingClientRect().right, paneRight: node.parentElement.getBoundingClientRect().right })),
      blocks: blocks.map(node => ({ client: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).overflowX })),
      files: Array.from(root.querySelectorAll('.coding-report li')).map(row => {
        const card = row.closest('.coding-report').getBoundingClientRect();
        const path = row.querySelector('code');
        const note = row.querySelector('.coding-report-note')?.getBoundingClientRect();
        const buttons = Array.from(row.querySelectorAll('button')).map(button => button.getBoundingClientRect());
        return {
          cardRight: card.right, rowRight: row.getBoundingClientRect().right,
          pathClient: path.clientWidth, pathScroll: path.scrollWidth,
          pathText: path.textContent, pathTitle: path.title,
          pathBottom: path.getBoundingClientRect().bottom,
          note: note ? { top: note.top, right: note.right } : null,
          buttons: buttons.map(button => ({ left: button.left, right: button.right, width: button.width })),
        };
      }),
      turns: Array.from(root.querySelectorAll('.coding-turn')).map(node => ({ width: node.getBoundingClientRect().width, children: Array.from(node.children).map(child => child.getBoundingClientRect().width) })),
      columns: Array.from(root.querySelectorAll('.chat-composer-area')).map(area => {
        const conversation = area.parentElement;
        const text = conversation.querySelector('.coding-reply').getBoundingClientRect();
        const input = area.querySelector('textarea');
        const inputBox = input.getBoundingClientRect();
        const inputCss = getComputedStyle(input);
        const card = area.querySelector('.chat-composer').getBoundingClientRect();
        const approval = area.querySelector('.coding-decision.approval').getBoundingClientRect();
        return {
          textLeft: text.left, textRight: text.right,
          inputLeft: inputBox.left + parseFloat(inputCss.paddingLeft),
          inputRight: inputBox.right - parseFloat(inputCss.paddingRight),
          cardLeft: card.left, cardRight: card.right, cardTop: card.top,
          approvalLeft: approval.left, approvalRight: approval.right, approvalBottom: approval.bottom,
          controlsRight: Math.max(...Array.from(area.querySelectorAll('button')).map(button => button.getBoundingClientRect().right)),
        };
      }),
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
        "--window-size=1920,1000",
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
      frame: {
        left: number;
        right: number;
        hostLeft: number;
        hostRight: number;
      };
      root: { client: number; scroll: number };
      panes: number[];
      transcripts: Array<{
        client: number;
        scroll: number;
        right: number;
        paneRight: number;
      }>;
      blocks: Array<{ client: number; scroll: number; overflow: string }>;
      files: Array<{
        cardRight: number;
        rowRight: number;
        pathClient: number;
        pathScroll: number;
        pathText: string;
        pathTitle: string;
        pathBottom: number;
        note: { top: number; right: number } | null;
        buttons: Array<{ left: number; right: number; width: number }>;
      }>;
      turns: Array<{ width: number; children: number[] }>;
      columns: Array<{
        textLeft: number;
        textRight: number;
        inputLeft: number;
        inputRight: number;
        cardLeft: number;
        cardRight: number;
        cardTop: number;
        approvalLeft: number;
        approvalRight: number;
        approvalBottom: number;
        controlsRight: number;
      }>;
    }>;
    assert.equal(layouts.length, 64);
    assert.ok(
      layouts.some(({ columns }) =>
        columns.some(
          ({ textLeft, textRight, cardLeft, cardRight }) =>
            textRight - textLeft === 920 && cardRight - cardLeft === 952,
        ),
      ),
      "The widest conversation should reach both desktop width limits",
    );
    for (const layout of layouts) {
      assert.equal(
        layout.frame.left,
        layout.frame.hostLeft,
        `At ${layout.width}px, the conversation must reach the host's left edge`,
      );
      assert.equal(
        layout.frame.right,
        layout.frame.hostRight,
        `At ${layout.width}px, the conversation must reach the host's right edge before the demo page loads`,
      );
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
      for (const transcript of layout.transcripts) {
        assert.equal(
          transcript.right,
          transcript.paneRight,
          "Keep each scrollbar at its conversation pane's right edge",
        );
        assert.ok(
          transcript.scroll <= transcript.client + 1,
          `At ${layout.width}px, transcript overflowed to ${transcript.scroll}px inside ${transcript.client}px`,
        );
      }
      for (const file of layout.files) {
        assert.ok(
          file.rowRight <= file.cardRight,
          `At ${layout.width}px, a delivered file row overflowed its card`,
        );
        assert.equal(
          file.pathTitle,
          file.pathText,
          "Keep the full path available",
        );
        assert.ok(file.pathClient > 0, "Keep the file path visible");
        if (file.note) {
          assert.ok(
            file.note.top >= file.pathBottom,
            "Place feedback below the file path",
          );
          assert.ok(
            file.note.right <= file.cardRight,
            "Keep long feedback inside the card",
          );
        }
        for (const button of file.buttons) {
          assert.ok(button.width >= 24, "Keep file actions usable");
          assert.ok(
            button.right <= file.cardRight,
            "Keep file actions inside the card",
          );
        }
        if (file.pathText.length > 100)
          assert.ok(file.pathScroll > file.pathClient, "Truncate long paths");
      }
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
      for (const column of layout.columns) {
        assert.ok(column.textRight - column.textLeft <= 920);
        assert.ok(column.cardRight - column.cardLeft <= 952);
        // Allow for subpixel rounding on split panes.
        assert.ok(
          Math.abs(column.textLeft - column.inputLeft) <= 0.5,
          JSON.stringify({ width: layout.width, column }),
        );
        assert.ok(
          Math.abs(column.textRight - column.inputRight) <= 0.5,
          JSON.stringify({ width: layout.width, column }),
        );
        assert.equal(column.approvalLeft, column.cardLeft);
        assert.equal(column.approvalRight, column.cardRight);
        assert.ok(column.approvalBottom <= column.cardTop - 12);
        assert.ok(column.controlsRight <= column.cardRight);
      }
    }
  },
);
