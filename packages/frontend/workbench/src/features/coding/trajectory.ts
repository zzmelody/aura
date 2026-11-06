import type { Turn } from "./turns";
import { language, type MessageReference } from "@aura/i18n/runtime";
import { toolMessage } from "../../tool-messages.ts";

/** DSH trajectory lanes, top to bottom. */
export type TrajectoryLane = "input" | "model" | "tool";

export type TrajectorySpan = {
  id: string;
  lane: TrajectoryLane;
  /** 1-based turn number. */
  turn: number;
  label: string | MessageReference;
  detail?: string;
  start: number;
  end: number;
  /** Still running at `now`; drawn up to `now`. */
  open: boolean;
  state: "ok" | "failed" | "stopped" | "running";
};

export type Trajectory = {
  spans: TrajectorySpan[];
  /** Turn start times, for the dashed boundaries. */
  turns: Array<{ turn: number; start: number; end: number }>;
  start: number;
  end: number;
};

/** Input marks have no duration; give them a visible sliver. */
const INPUT_MS = 1;

/**
 * Flattens turns into timed spans. Times come from DSH session events, so the
 * live stream and a reloaded log produce the same picture. An unfinished span
 * runs to `now` while its turn is live and to the turn end otherwise.
 */
export function buildTrajectory(
  turns: readonly Turn[],
  now: number,
): Trajectory {
  const spans: TrajectorySpan[] = [];
  const bounds: Trajectory["turns"] = [];
  turns.forEach((turn, index) => {
    const number = index + 1;
    const live = turn.status === "running";
    const cap = turn.endedAt ?? now;
    const settle = (end: number | undefined) => end ?? cap;
    bounds.push({ turn: number, start: turn.startedAt, end: cap });
    spans.push({
      id: `${turn.id}:prompt`,
      lane: "input",
      turn: number,
      label: toolMessage("trajectoryInput"),
      detail: turn.prompt,
      start: turn.startedAt,
      end: turn.startedAt + INPUT_MS,
      open: false,
      state: "ok",
    });
    turn.steers.forEach((at, steer) =>
      spans.push({
        id: `${turn.id}:steer:${steer}`,
        lane: "input",
        turn: number,
        label: toolMessage("trajectorySteer"),
        start: at,
        end: at + INPUT_MS,
        open: false,
        state: "ok",
      }),
    );
    turn.models.forEach((model, step) =>
      spans.push({
        id: `${turn.id}:model:${step}`,
        lane: "model",
        turn: number,
        label: toolMessage("trajectoryModel", { step: step + 1 }),
        start: model.startedAt,
        end: settle(model.endedAt),
        open: model.endedAt === undefined && live,
        state:
          model.endedAt !== undefined ? "ok" : live ? "running" : "stopped",
      }),
    );
    for (const tool of turn.tools)
      spans.push({
        id: `${turn.id}:tool:${tool.callId}`,
        lane: "tool",
        turn: number,
        label: tool.name,
        ...(tool.detail ? { detail: tool.detail } : {}),
        start: tool.startedAt,
        end: settle(tool.endedAt),
        open: tool.endedAt === undefined && live,
        state:
          tool.state === "ok"
            ? "ok"
            : tool.state === "failed"
              ? "failed"
              : tool.state === "running"
                ? "running"
                : "stopped",
      });
  });
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const start = bounds[0]?.start ?? now;
  const end = Math.max(start + 1, ...bounds.map((bound) => bound.end));
  return { spans, turns: bounds, start, end };
}

/** Compact localized units; normalize rounded seconds before splitting minutes. */
export function formatSpan(
  ms: number,
  locale: string = language.getSnapshot().locale,
): string {
  const format = (value: number, unit: string, digits = 0) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  if (ms < 1_000) return format(Math.max(0, Math.round(ms)), "millisecond");
  if (ms < 60_000) return format(ms / 1_000, "second", ms < 10_000 ? 1 : 0);
  const seconds = Math.round(ms / 1_000);
  return new Intl.ListFormat(locale, { style: "short", type: "unit" }).format([
    format(Math.floor(seconds / 60), "minute"),
    format(seconds % 60, "second"),
  ]);
}
