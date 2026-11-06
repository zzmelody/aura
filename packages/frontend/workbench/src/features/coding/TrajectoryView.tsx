import React, { useEffect, useMemo, useRef, useState } from "react";
import { useToolMessages, type ToolMessageKey } from "../../tool-messages.ts";
import { formatDate, formatNumber, messageText } from "@aura/i18n/runtime";
import type { Turn } from "./turns";
import {
  buildTrajectory,
  formatSpan,
  type TrajectoryLane,
  type TrajectorySpan,
} from "./trajectory";
import "./trajectory.css";

const lanes: Array<{ id: TrajectoryLane; label: ToolMessageKey }> = [
  { id: "input", label: "laneInput" },
  { id: "model", label: "laneModel" },
  { id: "tool", label: "laneTool" },
];

/**
 * DSH-style conversation trajectory: three lanes of timed spans over the
 * whole conversation, with turn boundaries, hover details and a drag-to-zoom
 * range that also filters the step table below.
 */
export function TrajectoryView({ turns }: { turns: readonly Turn[] }) {
  const { t, i18n } = useToolMessages();
  const locale = i18n.resolvedLanguage ?? "en";
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
    return <div className="trajectory-empty">{t("trajectoryEmpty")}</div>;

  return (
    <section className="trajectory" aria-label={t("trajectory")}>
      <div className="trajectory-toolbar">
        <span>
          {t("trajectorySummary", {
            turns: turns.length,
            steps: steps.length,
            duration: formatSpan(trajectory.end - trajectory.start, locale),
          })}
        </span>
        {range ? (
          <button
            type="button"
            className="dsh-button"
            onClick={() => setRange(undefined)}
          >
            {t("showAll")}
          </button>
        ) : (
          <span className="trajectory-hint">{t("zoomTimeHint")}</span>
        )}
      </div>
      <div className="trajectory-chart">
        <div className="trajectory-labels" aria-hidden="true">
          {lanes.map((lane) => (
            <span key={lane.id}>{t(lane.label)}</span>
          ))}
        </div>
        <div
          ref={plot}
          className="trajectory-plot"
          role="img"
          aria-label={t("timelinePlot")}
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
                <small>#{formatNumber(bound.turn)}</small>
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
              <strong>{messageText(hover.span.label, i18n)}</strong>
              {hover.span.detail ? <span>{hover.span.detail}</span> : null}
              <small>
                {t("turnTime", {
                  turn: hover.span.turn,
                  time:
                    hover.span.lane === "input"
                      ? formatDate(hover.span.start, { timeStyle: "medium" })
                      : formatSpan(hover.span.end - hover.span.start, locale),
                })}
                {hover.span.open ? ` · ${t("agentRunning")}` : ""}
              </small>
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="trajectory-steps"
        role="region"
        aria-label={t("trajectory")}
        tabIndex={0}
      >
        <table className="trajectory-table">
          <thead>
            <tr>
              <th scope="col">{t("turnColumn")}</th>
              <th scope="col">{t("stepColumn")}</th>
              <th scope="col">{t("contentColumn")}</th>
              <th scope="col">{t("startColumn")}</th>
              <th scope="col">{t("durationColumn")}</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((item) => (
              <tr key={item.id} className={item.state}>
                <td>#{formatNumber(item.turn)}</td>
                <td>
                  <span className={`trajectory-dot ${item.lane}`} />
                  {messageText(item.label, i18n)}
                </td>
                <td className="trajectory-detail" title={item.detail}>
                  {item.detail ?? ""}
                </td>
                <td>{formatDate(item.start, { timeStyle: "medium" })}</td>
                <td>
                  {item.open
                    ? t("agentRunning")
                    : formatSpan(item.end - item.start, locale)}
                  {item.state === "failed" ? ` · ${t("agentFailed")}` : ""}
                  {item.state === "stopped" ? ` · ${t("agentStopped")}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
