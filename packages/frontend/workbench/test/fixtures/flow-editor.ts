import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useFlowAnalysis } from "../../src/useFlowAnalysis";
import { useFlowDraft, starterFlow } from "../../src/flowDraft";
import { readFlowSvg } from "../../src/flow-analysis";
import { FlowStudio } from "../../src/screens/FlowStudio";
import { useContainerWidth, usePaneSplit } from "../../src/usePaneSplit.ts";
import { WORKFLOW_SPLIT_BOUNDS } from "../../src/workflow-split.ts";
import { LanguageProvider } from "@aura/i18n";
import { language } from "@aura/i18n/runtime";
import { workflowText } from "../../src/workflow-messages.ts";
import "../../src/styles.css";

// Headless virtual time advances timers without compositor frames. Drive frame
// callbacks on that same clock so zoom and pan can be observed deterministically.
window.requestAnimationFrame = (callback) =>
  window.setTimeout(() => callback(performance.now()), 16);
window.cancelAnimationFrame = window.clearTimeout.bind(window);

const checks: string[] = [];
function check(value: unknown, message: string) {
  if (!value) throw new Error(message);
  checks.push(message);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const drag = (element: HTMLElement, type: string, clientX: number) =>
  flushSync(() =>
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        button: 0,
        buttons: 1,
        pointerType: "mouse",
        clientX,
      }),
    ),
  );
let analysis: ReturnType<typeof useFlowAnalysis>;
let draft: ReturnType<typeof useFlowDraft>;
let layout: React.Dispatch<React.SetStateAction<string>>;
const source = starterFlow.replace("我的第一个 Flow", "Agent 分析示例").trim();
const svg = (
  id: string,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 240" data-analysis-id="${id}">
<title>Agent 分析示例</title><desc>接收任务，分析处理，输出结论。</desc>
<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" fill="var(--accent)" /></marker></defs>
<g fill="var(--surface)" stroke="var(--border)"><rect x="40" y="80" width="200" height="80" rx="12" /><rect x="350" y="80" width="200" height="80" rx="12" /><rect x="660" y="80" width="200" height="80" rx="12" /></g>
<g fill="none" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)"><path d="M240 120H340" /><path d="M550 120H650" /></g>
<g fill="var(--text)" font-size="20" text-anchor="middle"><text x="140" y="128">接收任务</text><text x="450" y="128">分析处理</text><text x="760" y="128">输出结论</text></g></svg>`;
/**
 * The real deck is a child of a Suspense whose lazy screens suspend, while the
 * measuring hook lives in the component above that boundary. So the parent
 * commits — and runs its layout effects — at a moment when the deck itself is
 * not in the DOM. Reproduce exactly that: a descendant of the deck suspends
 * once, so the hook must attach when the node finally arrives.
 */
let released = false;
const mounted = new Promise<void>((resolve) =>
  setTimeout(() => {
    released = true;
    resolve();
  }, 20),
);
function SuspendOnce({ children }: { children: React.ReactNode }) {
  if (!released) throw mounted;
  return children;
}
function Harness() {
  analysis = useFlowAnalysis();
  draft = useFlowDraft();
  const [mode, setMode] = React.useState("split");
  layout = setMode;
  const { ref: deck, width } = useContainerWidth<HTMLDivElement>();
  const split = usePaneSplit({
    storageKey: "aura.workflow.assistant-width",
    bounds: WORKFLOW_SPLIT_BOUNDS,
    containerWidth: width,
    active: true,
    labels: {
      label: workflowText("workflow"),
      hint: workflowText("workflow"),
      valueText: (value) => `${value}`,
    },
  });
  // The hook stays above the boundary while the deck renders inside it, so
  // this component's layout effects run while the deck is still unmounted.
  return React.createElement(
    React.Suspense,
    {
      fallback: React.createElement(
        "div",
        { className: "workspace-loading" },
        "正在加载内容…",
      ),
    },
    React.createElement(
      SuspendOnce,
      null,
      React.createElement(
        "div",
        {
          ref: deck,
          className: "workspace-deck",
          "data-workflow-layout": mode,
          "data-resizing": split.resizing || undefined,
          // Mirror App.tsx: leave the width to the stylesheet until measured.
          style: width
            ? ({
                "--workflow-assistant-width": `${split.width}px`,
              } as React.CSSProperties)
            : undefined,
        },
        React.createElement(
          "div",
          { className: "flow-area" },
          React.createElement(FlowStudio, {
            endpoint: "https://synthetic.example",
            flowId: "",
            draft,
            analysis,
            catalogState: {
              catalog: { flows: [], actions: [], presets: [] },
              refreshing: false,
              error: "",
              refresh: async () => {},
            },
            onBack() {},
            onRun() {},
          }),
        ),
        mode === "split" && !split.stacked
          ? React.createElement("div", {
              className: "workflow-split-handle",
              ...split.handle,
            })
          : null,
        React.createElement(
          "aside",
          { className: "assistant-area" },
          React.createElement(
            "div",
            { className: "assistant-heading" },
            "生成助手",
          ),
          React.createElement(
            "div",
            {
              className: "chat-screen",
              style: { justifyContent: "flex-end", padding: "16px" },
            },
            React.createElement("p", null, "已分析流程，并在画布绘制 SVG。"),
            React.createElement("textarea", {
              "aria-label": "对话输入框",
              defaultValue: "把分析步骤改成并行执行",
            }),
          ),
        ),
      ),
    ),
  );
}

async function inspect() {
  localStorage.clear();
  await language.systemChanged(["zh-CN"]);
  const locales = ["zh-CN", "en", "ja", "ko", "ru", "fr"] as const;
  const setItem = Storage.prototype.setItem;
  let writes = 0;
  Storage.prototype.setItem = function (key, value) {
    if (key === "aura.flow-draft.v1" || key === "aura.flow-analysis.v1")
      writes++;
    return setItem.call(this, key, value);
  };
  const parsed = readFlowSvg(svg("safe"), "test");
  check(
    parsed?.width === 900 && parsed.height === 240,
    "valid SVG preserves its viewBox",
  );
  check(
    parsed?.svg.includes("url(#test-0)") && parsed.svg.includes('id="test-0"'),
    "local marker references are namespaced together",
  );
  for (const content of [
    "<script>alert(1)</script>",
    "<foreignObject><div>HTML</div></foreignObject>",
    '<image href="https://example.com/track" />',
    '<use href="#other" />',
    '<rect onclick="alert(1)" />',
    '<rect style="fill:url(https://example.com/track)" />',
    '<path fill="url(https://example.com/track)" />',
    '<animate attributeName="fill" values="red;blue" />',
  ])
    check(
      !readFlowSvg(svg("unsafe").replace("</svg>", content + "</svg>"), "bad"),
      "unsafe SVG content is rejected: " + content.split(" ")[0],
    );
  check(
    !readFlowSvg(svg("bad").replace("900 240", "0 0"), "bad"),
    "zero-size viewBox is rejected",
  );
  check(
    !readFlowSvg(svg("bad").replace("900 240", "Infinity 240"), "bad"),
    "unbounded viewBox is rejected",
  );
  check(
    !readFlowSvg('<!DOCTYPE svg [<!ENTITY x "boom">]>' + svg("bad"), "bad"),
    "document entities are rejected",
  );
  const root = createRoot(document.getElementById("root")!);
  const render = () =>
    root.render(
      React.createElement(LanguageProvider, null, React.createElement(Harness)),
    );
  flushSync(render);
  check(
    !document.querySelector(".assistant-area") &&
      !!document.querySelector(".workspace-loading"),
    "the deck starts behind a Suspense fallback, as in the real workbench",
  );
  for (let i = 0; i < 30 && !document.querySelector(".assistant-area"); i++)
    await settle();
  // The deck mounted after the parent's first layout effect. A measuring hook
  // that only observes on that first run reports 0 forever, which collapsed
  // the assistant to nothing; it must stay usable here.
  const revealed = document
    .querySelector(".assistant-area")!
    .getBoundingClientRect().width;
  check(
    revealed >= WORKFLOW_SPLIT_BOUNDS.side,
    `assistant is usable after mounting behind a fallback (${revealed}px)`,
  );
  check(
    !document.querySelector('[role="tab"], .flow-code'),
    "editor has no code tab or code editor",
  );
  const measured = document
    .querySelector(".assistant-area")!
    .getBoundingClientRect().width;
  check(
    measured >= WORKFLOW_SPLIT_BOUNDS.side,
    `assistant keeps a usable width once measured (${measured}px)`,
  );
  const initialId = analysis.target!.id;
  const reply =
    "已完成。\n```javascript\n" +
    source +
    "\n```\n```svg\n" +
    svg(initialId) +
    "\n```";
  flushSync(() => {
    const result = analysis.accept(reply);
    if (result?.code) draft.update(result.code);
  });
  await settle();
  check(
    draft.code === source && !!document.querySelector(".flow-svg-position svg"),
    "code and Agent SVG are applied as one revision",
  );
  check(
    document.querySelector(".flow-svg-position svg title")?.textContent ===
      "Agent 分析示例",
    "canvas displays the Agent's SVG",
  );
  const shape = document.querySelector(".flow-svg-position") as HTMLElement;
  const beforeZoom = shape.style.transform;
  (
    document.querySelector('[aria-label="放大流程图"]') as HTMLButtonElement
  ).click();
  await settle();
  check(
    shape.style.transform !== beforeZoom,
    `SVG zoom controls update the viewport (${beforeZoom} -> ${shape.style.transform})`,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  const zoomed = shape.style.transform;
  const targetId = analysis.target!.id;
  const graph = shape.querySelector("svg");
  const input = document.querySelector<HTMLInputElement>(
    '.workflow-editor input[type="file"]',
  )!;
  const transfer = new DataTransfer();
  transfer.items.add(
    new File(["x".repeat(100_001)], "Original workflow.js", {
      type: "text/javascript",
    }),
  );
  input.files = transfer.files;
  flushSync(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  const menu = document.querySelector<HTMLDetailsElement>(".flow-more")!;
  menu.open = true;
  const originalWrites = writes;
  for (const locale of locales) {
    await language.select(locale);
    await settle();
    check(
      document.querySelector(".editor-notice span")?.textContent ===
        workflowText("workflowFileTooLarge"),
      `import validation follows ${locale}`,
    );
    check(
      document.querySelector(".graph-panel")?.getAttribute("aria-label") ===
        workflowText("graphRegion"),
      `diagram controls follow ${locale}`,
    );
    check(
      menu.open && menu === document.querySelector(".flow-more"),
      `open menu survives ${locale}`,
    );
    check(
      shape === document.querySelector(".flow-svg-position") &&
        shape.style.transform === zoomed &&
        graph === shape.querySelector("svg"),
      `diagram and viewport survive ${locale} (shape=${shape === document.querySelector(".flow-svg-position")}, svg=${graph === shape.querySelector("svg")}, ${zoomed} -> ${shape.style.transform})`,
    );
    check(
      analysis.target!.id === targetId &&
        draft.code === source &&
        draft.canUndo &&
        writes === originalWrites,
      `language ${locale} preserves draft, undo, analysis identity and storage`,
    );
  }
  menu.open = false;
  flushSync(() => draft.update(source + "\n// next revision"));
  await settle();
  check(
    !document.querySelector(".flow-svg-position"),
    "source changes hide a diagram for the previous revision",
  );
  flushSync(() => analysis.accept(reply));
  await settle();
  check(
    draft.code.endsWith("// next revision") &&
      !document.querySelector(".flow-svg-position"),
    "a stale Agent response cannot replace the active revision",
  );
  const id = analysis.target!.id;
  flushSync(() =>
    analysis.accept(
      "```svg\n" +
        svg(id).replace("</svg>", "<script>alert(1)</script></svg>") +
        "\n```",
    ),
  );
  await settle();
  check(
    !!analysis.error && !document.querySelector(".flow-svg-position"),
    "invalid SVG reports a recoverable error without replacing the draft",
  );
  for (const locale of locales) {
    await language.select(locale);
    await settle();
    check(
      analysis.error === workflowText("analysisSvgInvalid") &&
        analysis.target!.id === id,
      `analysis failure follows ${locale} without starting another analysis`,
    );
  }
  flushSync(() => draft.undo());
  await settle();
  check(
    !!document.querySelector(".flow-svg-position svg"),
    "undo restores the matching cached SVG",
  );
  // The canvas/assistant divider drags like the conversation split: a gesture
  // only previews the width, and only the finished gesture is persisted. This
  // runs before the responsive loop below, so the split width still comes from
  // the hook's synchronous first measurement: ResizeObserver callbacks are
  // tied to the rendering loop, which headless virtual time does not drive
  // reliably, so a resize here would make the drag checks flaky.
  const handle = document.querySelector<HTMLElement>(".workflow-split-handle")!;
  handle.setPointerCapture = () => {};
  const edge = () =>
    document.querySelector(".assistant-area")!.getBoundingClientRect().left;
  const graphBefore = document.querySelector(".flow-svg-position svg");
  const restingEdge = edge();
  drag(handle, "pointerdown", restingEdge);
  drag(handle, "pointermove", restingEdge - 120);
  await settle();
  const draggedEdge = edge();
  check(
    draggedEdge < restingEdge - 100,
    `dragging the divider widens the assistant (${restingEdge} -> ${draggedEdge})`,
  );
  check(
    document.querySelector(".flow-svg-position svg") === graphBefore &&
      draft.code === source,
    "resizing never remounts the canvas or touches the draft",
  );
  check(
    localStorage.getItem("aura.workflow.assistant-width") === null,
    "an in-progress drag is not persisted",
  );
  for (const locale of locales) {
    await language.select(locale);
    await settle();
    check(
      document.querySelector(".workflow-split-handle") === handle &&
        Math.abs(edge() - draggedEdge) <= 1,
      `the active drag survives ${locale}`,
    );
  }
  drag(handle, "pointerup", restingEdge - 120);
  await settle();
  const committed = handle.getAttribute("aria-valuenow");
  check(
    localStorage.getItem("aura.workflow.assistant-width") === committed,
    `releasing commits the width once (${committed})`,
  );
  drag(handle, "pointerdown", edge());
  drag(handle, "pointermove", edge() - 80);
  flushSync(() =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    ),
  );
  await settle();
  check(
    handle.getAttribute("aria-valuenow") === committed &&
      localStorage.getItem("aura.workflow.assistant-width") === committed,
    "Escape abandons a drag and keeps the committed width",
  );
  flushSync(() =>
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  await settle();
  check(
    localStorage.getItem("aura.workflow.assistant-width") === null &&
      handle.getAttribute("aria-valuenow") !== committed,
    "double-click restores the default width",
  );
  const host = document.getElementById("root")!;
  for (const width of [1120, 760, 360, 320, 1120]) {
    host.style.width = width + "px";
    flushSync(() => layout(width >= 720 ? "split" : "stacked"));
    await settle();
    const flow = document.querySelector(".flow-area")!.getBoundingClientRect();
    const chat = document
      .querySelector(".assistant-area")!
      .getBoundingClientRect();
    check(
      flow.width > 0 && flow.height > 0 && chat.width > 0 && chat.height > 0,
      `both panels remain visible at ${width}px`,
    );
    check(
      width >= 720 ? chat.left >= flow.right - 1 : chat.top >= flow.bottom - 1,
      `panels do not overlay at ${width}px`,
    );
    check(
      host.scrollWidth <= host.clientWidth + 1,
      `layout does not overflow at ${width}px`,
    );
    for (const locale of locales) {
      await language.select(locale);
      await settle();
      const editor = document.querySelector<HTMLElement>(".workflow-editor")!;
      check(
        editor.scrollWidth <= editor.clientWidth + 1 &&
          host.scrollWidth <= host.clientWidth + 1,
        `editor does not overflow in ${locale} at ${width}px`,
      );
    }
  }
  for (const [background, surface, text, accent] of [
    ["#111114", "#242428", "#ededf0", "#bda1ff"],
    ["#ffffff", "#f4f4f6", "#202024", "#6942b4"],
  ]) {
    host.style.setProperty("--background", background);
    host.style.setProperty("--surface", surface);
    host.style.setProperty("--text", text);
    host.style.setProperty("--accent", accent);
    await settle();
    check(
      getComputedStyle(document.querySelector(".flow-svg-position text")!)
        .fill !== "rgb(0, 0, 0)",
      "SVG text follows the active theme",
    );
  }
  let failedWrites = 0;
  Storage.prototype.setItem = function (key, value) {
    if (key === "aura.flow-draft.v1") {
      failedWrites++;
      throw new Error("Synthetic storage failure");
    }
    return setItem.call(this, key, value);
  };
  flushSync(() => draft.edit(source + "\n// original unsaved edit"));
  await new Promise((resolve) => setTimeout(resolve, 350));
  for (const locale of locales) {
    await language.select(locale);
    await settle();
    check(
      draft.saveError === workflowText("draftSaveFailed") &&
        draft.code.endsWith("// original unsaved edit") &&
        failedWrites === 1,
      `save failure and unsaved code survive ${locale} without a write retry`,
    );
  }
  Storage.prototype.setItem = setItem;
  flushSync(() => draft.edit(source));
  await new Promise((resolve) => setTimeout(resolve, 350));
  flushSync(() => root.render(null));
  flushSync(render);
  await settle();
  check(
    draft.code === source && !!document.querySelector(".flow-svg-position svg"),
    "reload restores the draft and its matching SVG",
  );
  document.getElementById("result")!.textContent = JSON.stringify({ checks });
}
void inspect().catch((error: unknown) => {
  document.getElementById("result")!.textContent = JSON.stringify({
    checks,
    error: String(error),
  });
});
