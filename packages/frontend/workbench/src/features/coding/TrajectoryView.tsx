import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Turn } from "./turns";
import {
  buildTrajectory,
  formatSpan,
  type TrajectoryLane,
  type TrajectorySpan,
} from "./trajectory";
import "./trajectory.css";

const lanes: Array<{ id: TrajectoryLane; label: string }> = [
  { id: "input", label: "输入" },
  { id: "model", label: "模型" },
  { id: "tool", label: "工具" },
];

/**
 * DSH-style conversation trajectory: three lanes of timed spans over the
 * whole conversation, with turn boundaries, hover details and a drag-to-zoom
 * range that also filters the step table below.
 */
export function TrajectoryView({ turns }: { turns: readonly Turn[] }) {
  const running = turns.some((turn) => turn.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);
  const trajectory = useMemo(() => buildTrajectory(turns, now), [turns, now]);
  const [range, setRange] = useState<[number, number]>();
  const [hover, setHover] = useState<{ span: TrajectorySpan; x: number }>();
  const [drag, setDrag] = useState<[number, number]>();
  const plot = useRef<HTMLDivElement>(null);

  const [from, to] = range ?? [trajectory.start, trajectory.end];
  const span = Math.max(1, to - from);
  const percent = (time: number) => ((time - from) / span) * 100;
  const timeAt = (clientX: number) => {
    const box = plot.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return from + ratio * span;
  };
  const visible = trajectory.spans.filter(
    (item) => item.end >= from && item.start <= to,
  );
  const steps = visible.filter((item) => item.lane !== "input");

  if (!turns.length)
    return (
      <div className="trajectory-empty">
        发送第一条消息后，这里会按时间展示每一轮的模型请求与工具调用。
      </div>
    );

  return (
    <section className="trajectory" aria-label="对话轨迹">
      <div className="trajectory-toolbar">
        <span>
          {turns.length} 轮 · {steps.length} 个步骤 · 共{" "}
          {formatSpan(trajectory.end - trajectory.start)}
        </span>
        {range ? (
          <button
            type="button"
            className="dsh-button"
            onClick={() => setRange(undefined)}
          >
            显示全部
          </button>
        ) : (
          <span className="trajectory-hint">拖动选择时间段可放大</span>
        )}
      </div>
      <div className="trajectory-chart">
        <div className="trajectory-labels" aria-hidden="true">
          {lanes.map((lane) => (
            <span key={lane.id}>{lane.label}</span>
          ))}
        </div>
        <div
          ref={plot}
          className="trajectory-plot"
          role="img"
          aria-label="按时间排列的输入、模型与工具步骤"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const at = timeAt(event.clientX);
            setDrag([at, at]);
          }}
          onPointerMove={(event) => {
            if (drag) setDrag([drag[0], timeAt(event.clientX)]);
          }}
          onPointerUp={() => {
            if (drag) {
              const [a, b] = [Math.min(...drag), Math.max(...drag)];
              // A click without a real drag keeps the current range.
              if (b - a > span * 0.01) setRange([a, b]);
            }
            setDrag(undefined);
          }}
          onPointerLeave={() => setHover(undefined)}
        >
          {trajectory.turns.map((bound) =>
            bound.start >= from && bound.start <= to ? (
              <span
                key={bound.turn}
                className="trajectory-turn"
                style={{ left: `${percent(bound.start)}%` }}
              >
                <small>#{bound.turn}</small>
              </span>
            ) : null,
          )}
          {lanes.map((lane, row) => (
            <div
              key={lane.id}
              className="trajectory-lane"
              style={{ top: `${row * 16 + 4}px` }}
            >
              {visible
                .filter((item) => item.lane === lane.id)
                .map((item) => {
                  const left = Math.max(0, percent(item.start));
                  const right = Math.min(100, percent(item.end));
                  return (
                    <span
                      key={item.id}
                      className={`trajectory-span ${item.lane} ${item.state}`}
                      style={{
                        left: `${left}%`,
                        width: `max(${right - left}%, 3px)`,
                      }}
                      onPointerEnter={(event) =>
                        setHover({
                          span: item,
                          x:
                            event.clientX -
                            plot.current!.getBoundingClientRect().left,
                        })
                      }
                    />
                  );
                })}
            </div>
          ))}
          {drag ? (
            <span
              className="trajectory-selection"
              style={{
                left: `${percent(Math.min(...drag))}%`,
                width: `${Math.abs(percent(drag[1]) - percent(drag[0]))}%`,
              }}
            />
          ) : null}
          {hover && !drag ? (
            <span
              className="trajectory-tooltip"
              role="tooltip"
              // Keep the 280px card inside the plot near either edge.
              style={{
                left: `clamp(140px, ${hover.x}px, calc(100% - 140px))`,
              }}
            >
              <strong>{hover.span.label}</strong>
              {hover.span.detail ? <span>{hover.span.detail}</span> : null}
              <small>
                第 {hover.span.turn} 轮 ·{" "}
                {hover.span.lane === "input"
                  ? new Date(hover.span.start).toLocaleTimeString("zh-CN")
                  : formatSpan(hover.span.end - hover.span.start)}
                {hover.span.open ? " · 进行中" : ""}
              </small>
            </span>
          ) : null}
        </div>
      </div>
      <table className="trajectory-table">
        <thead>
          <tr>
            <th scope="col">轮次</th>
            <th scope="col">步骤</th>
            <th scope="col">内容</th>
            <th scope="col">开始</th>
            <th scope="col">耗时</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((item) => (
            <tr key={item.id} className={item.state}>
              <td>#{item.turn}</td>
              <td>
                <span className={`trajectory-dot ${item.lane}`} />
                {item.label}
              </td>
              <td className="trajectory-detail" title={item.detail}>
                {item.detail ?? ""}
              </td>
              <td>{new Date(item.start).toLocaleTimeString("zh-CN")}</td>
              <td>
                {item.open ? "进行中" : formatSpan(item.end - item.start)}
                {item.state === "failed" ? " · 失败" : ""}
                {item.state === "stopped" ? " · 已停止" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
