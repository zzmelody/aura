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
  "macOS page titles and tool tabs clear navigation at rest and during sidebar motion",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to run the browser layout regression"
        : false,
    timeout: 30_000,
  },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "aura-macos-titlebar-"));
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
<body><div class="aura-root workbench" style="height:800px"></div><pre id="result"></pre>
<script>
const root = document.querySelector('.workbench');
root.style.setProperty('--background', 'rgb(21, 21, 23)');
root.style.setProperty('--sidebar', 'rgb(27, 27, 28)');
root.dataset.theme = 'dark';
const results = [];
const button = label => '<button class="icon-control" aria-label="' + label + '">' + label + '</button>';
const navigation = '<header class="workspace-menubar"><div class="window-navigation">' + button('←') + button('→') + button('侧栏') + '</div></header>';
const sidebar = width => '<div class="resizable-sidebar" style="--sidebar-width:' + width + 'px"><aside class="workspace-sidebar">新任务</aside><div class="sidebar-resize-handle"></div></div>';
const title = '<strong class="coding-title">一个需要完整保留操作按钮的很长对话标题</strong>' + button('…');
const conversation = side => '<div class="workspace-deck"><div class="assistant-area standalone"><div class="studio-area"><section class="coding-studio chat-screen studio-main"><div class="coding-panes" style="--coding-side-width:440px"><div class="coding-pane coding-main-column"><header class="coding-header coding-title-row">' + title + '</header><p class="coding-notice">工作空间提示仍位于标题下方</p><div class="coding-pane coding-main-transcript">对话内容</div></div>' + (side ? '<div class="coding-split-handle"></div><aside class="coding-side"><header class="coding-tools-header"><div class="coding-tool-tabs"><div class="coding-tool-tab active"><button role="tab">zsh</button>' + button('×') + '</div></div>' + button('+') + '<div class="coding-tools-spacer"></div>' + button('收起') + '</header><section class="coding-terminal coding-pane">终端内容</section></aside>' : '') + '</div></section></div></div></div>';
const page = '<header class="workspace-header"><div class="workspace-heading"><strong>设置</strong></div>' + button('…') + '</header><div class="workspace-deck">页面内容</div>';
for (const os of ['darwin', 'win32', 'web'])
for (const width of [760, 900, 1360, 2400])
for (const collapsed of [false, true])
for (const layout of ['page', 'conversation'])
for (const side of [false, true]) {
  const integrated = os === 'darwin' && width >= 900;
  root.dataset.platform = os === 'web' ? 'web' : 'desktop';
  root.dataset.os = os;
  root.toggleAttribute('data-native-sidebar', os === 'darwin');
  root.style.width = width + 'px';
  if (integrated) root.dataset.titlebarLayout = layout;
  else delete root.dataset.titlebarLayout;
  root.toggleAttribute('data-sidebar-collapsed', collapsed);
  const sidebarWidth = width === 1360 ? 480 : 240;
  root.innerHTML = navigation + '<div class="workspace-body" style="--sidebar-width:' + sidebarWidth + 'px">' + (!collapsed && width >= 900 ? sidebar(sidebarWidth) : '') + '<main class="workspace-main">' + (layout === 'page' ? page : conversation(side)) + '</main></div>';
  const panes = root.querySelector('.coding-panes');
  if (panes && side && panes.clientWidth < 648) {
    panes.setAttribute('data-stacked', '');
    panes.setAttribute('data-tools-only', '');
    panes.querySelector('.coding-split-handle').hidden = true;
  }
  const rect = node => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  };
  const nav = root.querySelector('.workspace-menubar');
  const headers = Array.from(root.querySelectorAll('.workspace-header, .coding-header, .coding-tools-header')).filter(node => node.getBoundingClientRect().width > 0);
  const controls = Array.from(root.querySelectorAll('header button')).filter(node => node.getBoundingClientRect().width > 0);
  results.push({
    os, width, collapsed, layout, side, integrated,
    nav: rect(nav), headers: headers.map(rect),
    navigationRegion: getComputedStyle(root.querySelector('.window-navigation')).webkitAppRegion,
    sidebarBackgroundRegion: root.querySelector('.resizable-sidebar') ? getComputedStyle(root.querySelector('.resizable-sidebar'), '::before').webkitAppRegion : null,
    sidebarDragLeft: root.querySelector('.resizable-sidebar') ? parseFloat(getComputedStyle(root.querySelector('.resizable-sidebar'), '::after').left) : null,
    headerRegions: headers.map(node => getComputedStyle(node).webkitAppRegion),
    headerDragLeft: headers.map(node => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node, '::before').left)),
    contentTop: root.querySelector('.coding-notice')?.getBoundingClientRect().top,
    controls: controls.map(node => {
      const box = node.getBoundingClientRect();
      return {
        ...rect(node), region: getComputedStyle(node).webkitAppRegion,
        clickable: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === node,
        navigation: !!node.closest('.workspace-menubar'),
      };
    }),
    scroll: root.scrollWidth, client: root.clientWidth,
    sidebar: root.querySelector('.workspace-sidebar') ? rect(root.querySelector('.workspace-sidebar')) : null,
  });
}
root.dataset.platform = 'desktop';
root.dataset.os = 'darwin';
root.dataset.nativeSidebar = '';
root.dataset.titlebarLayout = 'page';
root.style.width = '1360px';
delete root.dataset.sidebarCollapsed;
root.innerHTML = navigation + '<div class="workspace-body" style="--sidebar-width:280px">' + sidebar(280) + '<main class="workspace-main">' + page + '</main></div>';
const body = root.querySelector('.workspace-body');
const sidebarSurface = getComputedStyle(body.querySelector('.resizable-sidebar'));
const surfaces = {
  reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
  window: getComputedStyle(root).backgroundColor,
  sidebarTint: sidebarSurface.backgroundColor,
  sidebarWash: sidebarSurface.backgroundImage,
  sidebarContent: getComputedStyle(body.querySelector('.workspace-sidebar')).backgroundColor,
  titleStrip: getComputedStyle(body.querySelector('.resizable-sidebar'), '::before').backgroundColor,
  conversation: getComputedStyle(body.querySelector('.workspace-main')).backgroundColor,
};
const motionBox = () => {
  const panel = body.querySelector('.workspace-sidebar').getBoundingClientRect();
  return {
    width: body.querySelector('.resizable-sidebar').getBoundingClientRect().width,
    panelWidth: panel.width, panelEdge: panel.right,
    mainEdge: body.querySelector('.workspace-main').getBoundingClientRect().left,
    headingLeft: body.querySelector('.workspace-heading').getBoundingClientRect().left,
    navigationRight: root.querySelector('.workspace-menubar').getBoundingClientRect().right,
  };
};
const expanded = motionBox();
root.dataset.sidebarCollapsed = '';
const transition = body.getAnimations().find(animation => animation instanceof CSSTransition);
if (transition) {
  transition.pause();
  transition.currentTime = transition.effect.getTiming().duration / 3;
}
const moving = motionBox();
root.dataset.reduced = 'true';
const collapsed = motionBox();
document.querySelector('#result').textContent = JSON.stringify({ layouts: results, expanded, moving, collapsed, surfaces });
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
        "--window-size=2600,1000",
        "--dump-dom",
        pathToFileURL(fixture).href,
      ],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const result = stdout.match(/<pre id="result">([^<]+)<\/pre>/);
    assert.ok(result, "Chrome should return measured title bar layouts");
    type Box = { left: number; right: number; top: number; bottom: number };
    type Layout = {
      integrated: boolean;
      os: string;
      width: number;
      collapsed: boolean;
      layout: string;
      side: boolean;
      nav: Box;
      headers: Box[];
      navigationRegion: string;
      sidebarBackgroundRegion: string | null;
      sidebarDragLeft: number | null;
      headerRegions: string[];
      headerDragLeft: Array<number | null>;
      contentTop?: number;
      controls: Array<
        Box & { region: string; clickable: boolean; navigation: boolean }
      >;
      scroll: number;
      client: number;
      sidebar: Box | null;
    };
    type SidebarBox = {
      width: number;
      panelWidth: number;
      panelEdge: number;
      mainEdge: number;
      headingLeft: number;
      navigationRight: number;
    };
    const { layouts, expanded, moving, collapsed, surfaces } = JSON.parse(
      result[1]!,
    ) as {
      layouts: Layout[];
      expanded: SidebarBox;
      moving: SidebarBox;
      collapsed: SidebarBox;
      surfaces: {
        reducedTransparency: boolean;
        window: string;
        sidebarTint: string;
        sidebarWash: string;
        sidebarContent: string;
        titleStrip: string;
        conversation: string;
      };
    };
    assert.equal(surfaces.window, "rgba(0, 0, 0, 0)");
    assert.equal(surfaces.sidebarContent, "rgba(0, 0, 0, 0)");
    assert.equal(surfaces.titleStrip, "rgba(0, 0, 0, 0)");
    assert.equal(surfaces.conversation, "rgb(21, 21, 23)");
    if (surfaces.reducedTransparency) {
      assert.equal(surfaces.sidebarTint, "rgb(27, 27, 28)");
      assert.equal(surfaces.sidebarWash, "none");
    } else {
      assert.match(surfaces.sidebarTint, /\/ 0\.5\)$/u);
      assert.match(surfaces.sidebarWash, /^linear-gradient\(/u);
    }
    assert.equal(layouts.length, 96);
    for (const layout of layouts) {
      const label = JSON.stringify(layout);
      assert.ok(layout.scroll <= layout.client + 1, label);
      if (layout.os !== "web")
        assert.equal(layout.navigationRegion, "no-drag", label);
      if (layout.integrated && layout.sidebar) {
        assert.notEqual(layout.sidebarBackgroundRegion, "drag", label);
        assert.ok(
          layout.sidebarDragLeft !== null &&
            layout.sidebarDragLeft >= layout.nav.right,
          label,
        );
      }
      if (layout.integrated && layout.collapsed)
        layout.headers.forEach((header, index) => {
          if (header.left < layout.nav.right) {
            assert.equal(layout.headerRegions[index], "no-drag", label);
            const left = layout.headerDragLeft[index];
            assert.ok(left != null && left >= layout.nav.right, label);
          }
        });
      for (const header of layout.headers) {
        assert.equal(
          header.top,
          layout.integrated ? 0 : layout.nav.bottom,
          label,
        );
        if (layout.integrated) assert.equal(header.bottom, 48, label);
      }
      if (layout.integrated && layout.sidebar)
        assert.equal(layout.sidebar.top, 48, label);
      if (
        layout.integrated &&
        layout.contentTop !== undefined &&
        layout.headers.length === 2
      )
        assert.ok(layout.contentTop >= 48, label);
      for (const control of layout.controls) {
        assert.ok(control.clickable, label);
        if (layout.os === "darwin" && control.navigation)
          assert.ok(control.left >= 90, label);
        if (
          layout.os !== "web" &&
          (control.navigation ||
            layout.integrated ||
            layout.layout === "conversation")
        )
          assert.equal(control.region, "no-drag", label);
        if (layout.integrated && !control.navigation)
          assert.ok(control.left >= layout.nav.right, label);
      }
    }
    assert.equal(expanded.width, 280);
    assert.ok(
      moving.width > 0 && moving.width < expanded.width,
      moving.width.toString(),
    );
    assert.equal(collapsed.width, 0);
    for (const box of [expanded, moving, collapsed]) {
      assert.equal(box.panelWidth, expanded.width);
      assert.equal(box.panelEdge, box.mainEdge);
      assert.ok(box.headingLeft >= box.navigationRight, JSON.stringify(box));
    }
  },
);
