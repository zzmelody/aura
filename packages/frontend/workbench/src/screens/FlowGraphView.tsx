import React, {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Braces,
  ChevronRight,
  CirclePlay,
  FileOutput,
  GitBranch,
  GitFork,
  Maximize2,
  Repeat2,
  X,
  Wrench,
} from "lucide-react";
import {
  buildFlowGraph,
  layoutFlowGraph,
  type FlowGraphNode,
} from "../flowGraph";

import { useFlowViewport } from "../useFlowViewport";
import {
  zoomFlowViewport,
  type FlowViewport,
  type Point,
} from "../flowViewport";

const NODE_WIDTH = 184;
const NODE_HEIGHT = 86;

const kindMeta: Record<
  FlowGraphNode["kind"],
  { eyebrow: string; type: string; aria: string }
> = {
  input: { eyebrow: "INPUT", type: "流程入口", aria: "输入节点" },
  agent: { eyebrow: "AGENT", type: "Agent 调用", aria: "Agent 节点" },
  tool: { eyebrow: "TOOL", type: "工具调用", aria: "工具节点" },
  flow: { eyebrow: "FLOW", type: "子工作流", aria: "子工作流节点" },
  scope: { eyebrow: "SCOPE", type: "结构化作用域", aria: "作用域节点" },
  memo: { eyebrow: "MEMO", type: "持久化结果", aria: "存档节点" },
  checkpoint: { eyebrow: "CHECKPOINT", type: "人工输入", aria: "人工断点节点" },
  condition: { eyebrow: "IF", type: "条件分支", aria: "条件节点" },
  loop: { eyebrow: "LOOP", type: "循环控制", aria: "循环节点" },
  output: { eyebrow: "OUTPUT", type: "流程结果", aria: "输出节点" },
};

function NodeIcon({ kind }: { kind: FlowGraphNode["kind"] }) {
  if (kind === "input") return <CirclePlay size={16} />;
  if (kind === "output") return <FileOutput size={16} />;
  if (kind === "tool") return <Wrench size={16} />;
  if (kind === "flow") return <GitFork size={16} />;
  if (kind === "condition") return <GitBranch size={16} />;
  if (kind === "loop") return <Repeat2 size={16} />;
  return <Bot size={16} />;
}

export function FlowGraphView({
  code,
  onOpenCode,
  embedded = false,
}: {
  code: string;
  embedded?: boolean;
  onOpenCode(line?: number): void;
}) {
  const deferredCode = useDeferredValue(code);
  const graph = useMemo(() => buildFlowGraph(deferredCode), [deferredCode]);
  const layout = useMemo(() => layoutFlowGraph(graph), [graph]);
  const [selectedId, setSelectedId] = useState<string>();
  const canvas = useRef<HTMLDivElement>(null);
  const [offsets, setOffsets] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const drag = useRef<
    | {
        id?: string;
        pointer: number;
        x: number;
        y: number;
        start: { x: number; y: number };
        moved: boolean;
      }
    | undefined
  >(undefined);
  const suppressClick = useRef(false);
  useEffect(() => {
    setOffsets({});
    setSelectedId(undefined);
  }, [deferredCode]);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const graphFailed = Boolean(graph.error);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [graphFailed]);
  const fit = Math.max(
    embedded ? 0.2 : 0.4,
    Math.min(
      1,
      (size.width - 24) / layout.width,
      (size.height - 64) / layout.height,
    ),
  );
  const viewport = useFlowViewport(canvas, fit, deferredCode, !graph.error);
  const { zoom, pan } = viewport.view;
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<
    { view: FlowViewport; distance: number; anchor: Point } | undefined
  >(undefined);
  const markerId = useId().replace(/:/g, "");
  const selected = graph.nodes.find((node) => node.id === selectedId);
  const nodes = layout.nodes.map((node) => ({
    ...node,
    x: node.x + (offsets[node.id]?.x ?? 0),
    y: node.y + (offsets[node.id]?.y ?? 0),
  }));
  const positions = new Map(nodes.map((node) => [node.id, node]));
  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest(".graph-tools"))
      return;
    const node = (event.target as Element).closest<HTMLElement>(".flow-node");
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    (node ?? event.currentTarget).setPointerCapture(event.pointerId);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        view: viewport.current.current,
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        anchor: viewport.anchor({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
      };
      drag.current = undefined;
      suppressClick.current = true;
      return;
    }
    const id = node?.dataset.nodeId;
    drag.current = {
      id,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: id
        ? (offsets[id] ?? { x: 0, y: 0 })
        : viewport.current.current.pan,
      moved: false,
    };
    suppressClick.current = false;
  }
  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = viewport.anchor({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      viewport.commit(
        zoomFlowViewport(
          pinch.current.view,
          (pinch.current.view.zoom * Math.hypot(b.x - a.x, b.y - a.y)) /
            pinch.current.distance,
          pinch.current.anchor,
          mid,
        ),
      );
      return;
    }
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    suppressClick.current = true;
    if (current.id) {
      const id = current.id;
      setOffsets((values) => ({
        ...values,
        [id]: {
          x: current.start.x + dx / viewport.current.current.zoom,
          y: current.start.y + dy / viewport.current.current.zoom,
        },
      }));
    } else
      viewport.commit({
        ...viewport.current.current,
        pan: { x: current.start.x + dx, y: current.start.y + dy },
      });
  }
  function pointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    const wasPinching = Boolean(pinch.current);
    pinch.current = undefined;
    drag.current = undefined;
    if (wasPinching && pointers.current.size === 1) {
      const [pointer, point] = [...pointers.current.entries()][0];
      drag.current = {
        pointer,
        x: point.x,
        y: point.y,
        start: viewport.current.current.pan,
        moved: true,
      };
    }
  }

  const selectedEdges = new Set(
    graph.edges
      .filter(
        (edge) => edge.source === selected?.id || edge.target === selected?.id,
      )
      .map((edge) => edge.id),
  );
  const columns = new Map<number, number>();
  for (const node of layout.nodes)
    if (node.parallel && (node.kind === "agent" || node.kind === "tool"))
      columns.set(node.level, (columns.get(node.level) ?? 0) + 1);
  const orchestrationNodes = graph.nodes.filter(
    (node) => node.kind !== "input" && node.kind !== "output",
  );
  const agentCount = graph.nodes.filter((node) => node.kind === "agent").length;
  const toolCount = graph.nodes.filter((node) => node.kind === "tool").length;

  return (
    <div
      id={embedded ? undefined : "graph-panel"}
      className="graph-panel"
      role={embedded ? "region" : "tabpanel"}
      aria-labelledby={embedded ? undefined : "graph-tab"}
      aria-label={embedded ? "工作流节点图" : undefined}
    >
      {graph.error ? (
        <div className="graph-error" role="alert">
          <Braces size={20} />
          <div>
            <strong>流程图暂时无法生成</strong>
            <p>{graph.error}</p>
          </div>
          <button className="tool-button" onClick={() => onOpenCode()}>
            打开代码
          </button>
        </div>
      ) : (
        <div className="graph-workspace">
          <div
            className="graph-canvas-shell"
            ref={canvas}
            tabIndex={0}
            aria-label="流程图画布"
            aria-describedby={`gesture-help-${markerId}`}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "+" || event.key === "=" || event.key === "-") {
                event.preventDefault();
                viewport.commit(
                  zoomFlowViewport(
                    viewport.current.current,
                    viewport.current.current.zoom *
                      (event.key === "-" ? 0.85 : 1.15),
                    { x: 0, y: 0 },
                  ),
                );
              }
              if (event.key === "0") {
                event.preventDefault();
                viewport.reset();
              }
              const delta = {
                ArrowLeft: [30, 0],
                ArrowRight: [-30, 0],
                ArrowUp: [0, 30],
                ArrowDown: [0, -30],
              }[event.key];
              if (delta) {
                event.preventDefault();
                viewport.commit({
                  ...viewport.current.current,
                  pan: {
                    x: viewport.current.current.pan.x + delta[0],
                    y: viewport.current.current.pan.y + delta[1],
                  },
                });
              }
            }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onLostPointerCapture={pointerEnd}
          >
            <div className="graph-caption">
              <span>
                只读静态投影 · {orchestrationNodes.length} 个节点 · {agentCount}{" "}
                Agent
                {toolCount ? ` · ${toolCount} 工具` : ""}
              </span>
              <span>滚轮缩放 · 双指平移 / 捏合</span>
            </div>
            <span className="sr-only" id={`gesture-help-${markerId}`}>
              滚轮缩放；触摸板双指平移、捏合缩放；触屏单指拖动、双指缩放。Shift
              加滚轮平移。键盘加减号缩放，方向键平移，0 适应画布。
            </span>
            <div className="graph-tools" aria-label="流程图视图">
              <span className="graph-zoom-value" aria-label="当前缩放">
                {Math.round(zoom * 100)}%
              </span>
              <button
                className="icon-control"
                aria-label="适应画布"
                title="适应画布（0）"
                onClick={() => {
                  viewport.reset();
                  setOffsets({});
                }}
              >
                <Maximize2 size={14} />
              </button>
            </div>
            <div className="graph-scroll">
              <div
                className="graph-scale"
                style={{
                  transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
                  width: layout.width * zoom,
                  height: layout.height * zoom,
                }}
              >
                <div
                  className="graph-canvas"
                  style={{
                    width: layout.width,
                    height: layout.height,
                    transform: `scale(${zoom})`,
                  }}
                >
                  <svg
                    className="graph-edges"
                    aria-hidden="true"
                    width={layout.width}
                    height={layout.height}
                  >
                    <defs>
                      <marker
                        id={`arrow-${markerId}`}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto"
                      >
                        <path d="M 0 0 L 8 4 L 0 8 z" />
                      </marker>
                      <marker
                        id={`arrow-active-${markerId}`}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto"
                      >
                        <path d="M 0 0 L 8 4 L 0 8 z" />
                      </marker>
                    </defs>
                    {graph.edges.map((edge) => {
                      const source = positions.get(edge.source);
                      const target = positions.get(edge.target);
                      if (!source || !target) return null;
                      const active = selectedEdges.has(edge.id);
                      const fromX = source.x + NODE_WIDTH;
                      const fromY = source.y + NODE_HEIGHT / 2;
                      const toX = edge.back ? target.x + NODE_WIDTH : target.x;
                      const toY = target.y + NODE_HEIGHT / 2;
                      const bend = Math.max(48, Math.abs(toX - fromX) / 2);
                      const skipsColumn = target.level > source.level + 1;
                      const backY = Math.min(
                        layout.height - 22,
                        Math.max(fromY, toY) + 68,
                      );
                      const path = edge.back
                        ? `M ${fromX} ${fromY} C ${fromX + 50} ${backY}, ${toX + 50} ${backY}, ${toX} ${toY}`
                        : skipsColumn
                          ? `M ${fromX} ${fromY} C ${fromX + 42} ${fromY}, ${fromX + 42} ${backY}, ${fromX + 92} ${backY} L ${toX - 82} ${backY} C ${toX - 34} ${backY}, ${toX - 34} ${toY}, ${toX} ${toY}`
                          : `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`;
                      const labelX = edge.back
                        ? (fromX + toX) / 2 + 28
                        : (fromX + toX) / 2;
                      const labelY =
                        edge.back || skipsColumn
                          ? backY - 5
                          : (fromY + toY) / 2 - 7;
                      return (
                        <g
                          key={edge.id}
                          className={`${active ? "active" : ""}${edge.back ? " back" : ""}`}
                        >
                          <path
                            d={path}
                            markerEnd={`url(#arrow${active ? "-active" : ""}-${markerId})`}
                          />
                          {edge.label ? (
                            <text x={labelX} y={labelY} textAnchor="middle">
                              {edge.label}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}
                  </svg>
                  {[...columns.entries()]
                    .filter(([, count]) => count > 1)
                    .map(([level, count]) => (
                      <div
                        className="parallel-label"
                        key={level}
                        style={{ left: 44 + level * 232 }}
                      >
                        <GitFork size={11} /> {count} 个并行步骤
                      </div>
                    ))}
                  {nodes.map((node) => (
                    <button
                      key={node.id}
                      data-node-id={node.id}
                      className={`flow-node node-${node.kind}${selected?.id === node.id ? " selected" : ""}`}
                      style={{ left: node.x, top: node.y }}
                      aria-label={`${kindMeta[node.kind].aria}：${node.label}`}
                      aria-pressed={selected?.id === node.id}
                      onClick={() => {
                        if (!suppressClick.current) setSelectedId(node.id);
                        suppressClick.current = false;
                      }}
                      onKeyDown={(event) => {
                        const delta = {
                          ArrowLeft: [-10, 0],
                          ArrowRight: [10, 0],
                          ArrowUp: [0, -10],
                          ArrowDown: [0, 10],
                        }[event.key];
                        if (!delta) return;
                        event.preventDefault();
                        setOffsets((values) => ({
                          ...values,
                          [node.id]: {
                            x: (values[node.id]?.x ?? 0) + delta[0],
                            y: (values[node.id]?.y ?? 0) + delta[1],
                          },
                        }));
                      }}
                    >
                      <span className="node-icon">
                        <NodeIcon kind={node.kind} />
                      </span>
                      <span className="node-copy">
                        <strong>{node.label}</strong>
                        <small>{node.subtitle}</small>
                      </span>
                      {node.control ? (
                        <span className="node-control">{node.control}</span>
                      ) : null}
                      {node.kind !== "input" && node.kind !== "output" ? (
                        <ChevronRight size={14} />
                      ) : null}
                      <i className="node-port input" />
                      <i className="node-port output" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {selected ? (
            <aside className="node-inspector" aria-label="节点详情">
              {selected ? (
                <>
                  <div className="inspector-heading">
                    <span className={`node-icon node-${selected.kind}`}>
                      <NodeIcon kind={selected.kind} />
                    </span>
                    <div>
                      <small>{kindMeta[selected.kind].eyebrow}</small>
                      <strong>{selected.label}</strong>
                    </div>
                    <button
                      className="icon-control"
                      aria-label="关闭节点详情"
                      onClick={() => setSelectedId(undefined)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <dl className="inspector-fields">
                    <div>
                      <dt>类型</dt>
                      <dd>{kindMeta[selected.kind].type}</dd>
                    </div>
                    {selected.preset ? (
                      <div>
                        <dt>Preset</dt>
                        <dd>{selected.preset}</dd>
                      </div>
                    ) : null}
                    {selected.agentOptions &&
                      Object.entries(selected.agentOptions).map(
                        ([key, value]) => (
                          <div key={key}>
                            <dt>{key}（声明）</dt>
                            <dd>{value}</dd>
                          </div>
                        ),
                      )}
                    {selected.kind === "agent" ? (
                      <div>
                        <dt>配置说明</dt>
                        <dd>
                          未声明参数继承默认值；表达式不在图中执行，生效配置见运行记录。
                        </dd>
                      </div>
                    ) : null}
                    {selected.parallel ? (
                      <div>
                        <dt>执行方式</dt>
                        <dd>与同组节点并行</dd>
                      </div>
                    ) : null}
                    {selected.control ? (
                      <div>
                        <dt>运行条件</dt>
                        <dd>{selected.control}</dd>
                      </div>
                    ) : null}
                    {selected.prompt ? (
                      <div className="inspector-prompt">
                        <dt>
                          {selected.kind === "condition" ||
                          selected.kind === "loop"
                            ? "表达式"
                            : selected.kind === "tool"
                              ? "调用参数"
                              : "Prompt"}
                        </dt>
                        <dd>{selected.prompt}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {selected.line ? (
                    <button
                      className="inspector-code-link"
                      onClick={() => onOpenCode(selected.line)}
                    >
                      <Braces size={13} /> 查看代码第 {selected.line} 行
                    </button>
                  ) : null}
                </>
              ) : null}
              {graph.warnings.length ? (
                <div className="graph-warnings">
                  <strong>动态编排</strong>
                  {graph.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}
