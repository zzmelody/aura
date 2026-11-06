export type FlowDiagram = {
  svg: string;
  width: number;
  height: number;
  title: string;
  description: string;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const tags = new Set([
  "svg",
  "g",
  "defs",
  "marker",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
]);
const attributes = new Set([
  "id",
  "viewBox",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "rx",
  "ry",
  "r",
  "cx",
  "cy",
  "d",
  "points",
  "transform",
  "fill",
  "stroke",
  "fill-opacity",
  "stroke-opacity",
  "opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "clip-rule",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "dx",
  "dy",
  "letter-spacing",
  "textLength",
  "lengthAdjust",
  "marker-start",
  "marker-mid",
  "marker-end",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "preserveAspectRatio",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "offset",
  "stop-color",
  "stop-opacity",
  "fx",
  "fy",
  "fr",
  "clip-path",
  "clipPathUnits",
  "color",
  "vector-effect",
  "data-analysis-id",
  "role",
  "aria-label",
  "aria-hidden",
]);
const referenceAttributes = new Set([
  "fill",
  "stroke",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

/** Accepts a small, inert SVG vocabulary; no HTML, script, CSS or network loads. */
export function readFlowSvg(
  source: string,
  prefix: string,
): FlowDiagram | undefined {
  if (source.length > 300_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) return;
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== SVG_NS ||
    parsed.querySelector("parsererror")
  )
    return;
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    !viewBox ||
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0 ||
    viewBox[2] > 20_000 ||
    viewBox[3] > 20_000
  )
    return;
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  if (elements.length > 1500) return;
  const ids = new Map<string, string>();
  for (const element of elements) {
    if (element.namespaceURI !== SVG_NS || !tags.has(element.localName)) return;
    let depth = 0;
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (++depth > 40) return;
    const id = element.getAttribute("id");
    if (id !== null) {
      if (!/^[a-zA-Z_][\w.-]*$/.test(id) || ids.has(id)) return;
      ids.set(id, `${prefix}-${ids.size}`);
    }
  }
  // Clone only allowed attributes and plain text. XML processing instructions,
  // comments, event handlers, CSS and external references never enter the page.
  function clone(element: Element): Element | undefined {
    const result = document.createElementNS(SVG_NS, element.localName);
    for (const attribute of Array.from(element.attributes)) {
      const { name, value } = attribute;
      if (name === "xmlns") continue;
      if (
        attribute.namespaceURI ||
        !attributes.has(name) ||
        /(?:url\s*\(|javascript:|data:|https?:|\\)/i.test(value)
      ) {
        const reference = /^url\(#([a-zA-Z_][\w.-]*)\)$/.exec(value);
        if (
          !referenceAttributes.has(name) ||
          !reference ||
          !ids.has(reference[1])
        )
          return;
        result.setAttribute(name, `url(#${ids.get(reference[1])!})`);
      } else result.setAttribute(name, name === "id" ? ids.get(value)! : value);
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const copied = clone(child as Element);
        if (!copied) return;
        result.append(copied);
      } else if (child.nodeType === Node.TEXT_NODE)
        result.append(document.createTextNode(child.textContent ?? ""));
    }
    return result;
  }
  const safe = clone(root);
  if (!safe) return;
  safe.setAttribute("xmlns", SVG_NS);
  safe.setAttribute("width", String(viewBox[2]));
  safe.setAttribute("height", String(viewBox[3]));
  safe.setAttribute("role", "img");
  return {
    svg: new XMLSerializer().serializeToString(safe),
    width: viewBox[2],
    height: viewBox[3],
    title: root.querySelector("title")?.textContent?.slice(0, 200) ?? "工作流",
    description: root.querySelector("desc")?.textContent?.slice(0, 2000) ?? "",
  };
}

/** Requires a complete SVG fence and the current source's analysis identity. */
export function extractFlowSvg(
  text: string,
  analysisId: string,
): string | undefined {
  const blocks = [...text.matchAll(/```svg[ \t]*\r?\n([\s\S]*?)```/g)];
  for (const block of blocks.reverse()) {
    const source = block[1].trim();
    const root = /^<svg\b([^>]*)>/i.exec(source);
    const id = root?.[1].match(
      /\bdata-analysis-id\s*=\s*["']([^"']*)["']/,
    )?.[1];
    if (id === analysisId && /<\/svg>$/.test(source)) return source;
  }
}

export function flowAnalysisInstructions(analysisId: string): string {
  return `先分析流程的目的、步骤、依赖、分支、并行与循环，然后直接绘制 SVG 流程图。每次分析或修改完成后，在回复末尾给出一个完整的 svg 代码块。根元素必须为 <svg xmlns="${SVG_NS}" viewBox="0 0 宽 高" data-analysis-id="${analysisId}">，含 title（流程名称）和 desc（流程说明）。用 rect/path/text 等 SVG 元素绘制中文节点、连线、箭头和分支标签；并行分支与循环回边清晰可辨。横向布局，节点文字可读，适当留白；背景透明，节点 fill="var(--surface)"、边框 stroke="var(--border)"、文字 fill="var(--text)"，重点用 var(--accent)，font-family="inherit"，以跟随当前主题。仅用 SVG 内联展示属性，不用 style/class、script、foreignObject、image、use、动画、事件、外部资源或链接；箭头用 defs/marker 和 url(#内部id)。允许 svg/g/defs/marker/path/rect/circle/ellipse/line/polyline/polygon/text/tspan/title/desc/linearGradient/radialGradient/stop/clipPath。不要返回 ReactFlow、节点 JSON 或 React 代码。流程图来自你的语义分析，不运行 Flow。仅分析时保留当前代码，不返回 javascript 代码块；修改流程时同时返回完整 javascript 代码块，SVG 必须对应这份最终代码。无法确认的动态行为在回复和图中说明。`;
}
