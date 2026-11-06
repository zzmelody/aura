import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { readFlowSvg, type FlowDiagram } from "../flow-analysis";
import { useFlowViewport } from "../useFlowViewport";
import {
  zoomFlowViewport,
  type FlowViewport,
  type Point,
} from "../flowViewport";

/** Displays the SVG drawn by the Agent; there is no node layout or source parser. */
export function FlowGraphView({
  diagram,
  embedded = false,
}: {
  diagram: FlowDiagram;
  embedded?: boolean;
}) {
  const id = useId().replace(/[^\w-]/g, "");
  const safe = useMemo(
    () => readFlowSvg(diagram.svg, `diagram-${id}`),
    [diagram.svg, id],
  );
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
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
  }, []);
  const fit = Math.max(
    0.05,
    Math.min(
      1,
      (size.width - 48) / diagram.width,
      (size.height - 96) / diagram.height,
    ),
  );
  const viewport = useFlowViewport(canvas, fit, diagram.svg, Boolean(safe));
  const { zoom, pan } = viewport.view;
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<
    | { point: Point; view: FlowViewport; distance?: number; anchor?: Point }
    | undefined
  >(undefined);
  function startGesture() {
    const [a, b] = [...pointers.current.values()];
    if (!a) {
      drag.current = undefined;
      return;
    }
    drag.current = {
      point: a,
      view: viewport.current.current,
      ...(b
        ? {
            distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
            anchor: viewport.anchor({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
          }
        : {}),
    };
  }
  function zoomBy(factor: number) {
    viewport.commit(
      zoomFlowViewport(
        viewport.current.current,
        viewport.current.current.zoom * factor,
        { x: 0, y: 0 },
      ),
    );
  }
  return (
    <div className="graph-panel" role="region" aria-label="Agent 生成的流程图">
      <div
        className="graph-canvas-shell flow-svg-shell"
        ref={canvas}
        tabIndex={0}
        aria-label="流程图画布"
        aria-describedby={`svg-help-${id}`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (["+", "=", "-", "0"].includes(event.key)) {
            event.preventDefault();
            if (event.key === "0") viewport.reset();
            else zoomBy(event.key === "-" ? 0.85 : 1.15);
          }
          const delta = {
            ArrowLeft: [30, 0],
            ArrowRight: [-30, 0],
            ArrowUp: [0, 30],
            ArrowDown: [0, -30],
          }[event.key];
          if (delta) {
            event.preventDefault();
            const view = viewport.current.current;
            viewport.commit({
              ...view,
              pan: { x: view.pan.x + delta[0], y: view.pan.y + delta[1] },
            });
          }
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as Element).closest(".graph-tools")
          )
            return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          startGesture();
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId) || !drag.current) return;
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          const [a, b] = [...pointers.current.values()];
          const gesture = drag.current;
          if (b && gesture.distance && gesture.anchor) {
            viewport.commit(
              zoomFlowViewport(
                gesture.view,
                (gesture.view.zoom * Math.hypot(b.x - a.x, b.y - a.y)) /
                  gesture.distance,
                gesture.anchor,
                viewport.anchor({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
              ),
            );
          } else
            viewport.commit({
              ...gesture.view,
              pan: {
                x: gesture.view.pan.x + a.x - gesture.point.x,
                y: gesture.view.pan.y + a.y - gesture.point.y,
              },
            });
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          startGesture();
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          startGesture();
        }}
        onLostPointerCapture={(event) => {
          pointers.current.delete(event.pointerId);
          startGesture();
        }}
      >
        <span className="sr-only" id={`svg-help-${id}`}>
          滚轮缩放，双指平移或捏合，拖动平移。键盘加减号缩放，方向键平移，0
          适应画布。
        </span>
        <div className="graph-tools" aria-label="流程图视图">
          <span className="graph-zoom-value" aria-label="当前缩放">
            {Math.round(zoom * 100)}%
          </span>
          <button
            className="icon-control"
            aria-label="缩小流程图"
            onClick={() => zoomBy(0.85)}
          >
            <ZoomOut size={14} />
          </button>
          <button
            className="icon-control"
            aria-label="放大流程图"
            onClick={() => zoomBy(1.15)}
          >
            <ZoomIn size={14} />
          </button>
          <button
            className="icon-control"
            aria-label="适应画布"
            onClick={viewport.reset}
          >
            <Maximize2 size={14} />
          </button>
          {!embedded && safe ? (
            <button
              className="icon-control"
              aria-label="导出 SVG"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      safe.svg.replace(
                        /var\((--[\w-]+)\)/g,
                        (match, token: string) =>
                          canvas.current
                            ? getComputedStyle(canvas.current)
                                .getPropertyValue(token)
                                .trim() || match
                            : match,
                      ),
                    ],
                    { type: "image/svg+xml;charset=utf-8" },
                  ),
                );
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "workflow.svg";
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              <Download size={14} />
            </button>
          ) : null}
        </div>
        {safe ? (
          <div
            className="flow-svg-position"
            style={{
              width: diagram.width,
              height: diagram.height,
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
            dangerouslySetInnerHTML={{ __html: safe.svg }}
          />
        ) : (
          <div className="flow-preview-empty" role="alert">
            流程图无法显示，请让 Agent 重新生成 SVG。
          </div>
        )}
        <div className="graph-caption">
          <span>Agent 分析 · SVG 流程图</span>
          <span>拖动平移 · 滚轮缩放</span>
        </div>
      </div>
    </div>
  );
}
