/** Only fixed stage names and numeric timings may cross the child stderr boundary. */
export const STARTUP_TIMING_PREFIX = "AURA_DSH_STARTUP ";
const stages = [
  "total",
  "profile",
  "process-spawn",
  "process-bootstrap",
  "dsh-load",
  "orchestration-setup",
  "plugin-presets",
  "plugin-backends",
  "flow-storage",
  "action-storage",
  "coding-storage",
  "workspace",
  "action-recovery",
  "discovery",
  "loader-settle",
  "flow-recovery",
  "handshake",
] as const;
export type StartupStage = (typeof stages)[number];

export interface StartupTiming {
  startupId: string;
  stage: StartupStage;
  status: "started" | "completed" | "failed";
  elapsedMs: number;
  durationMs: number;
}

export function parseStartupTiming(value: unknown): StartupTiming | undefined {
  if (typeof value !== "object" || value === null) return;
  const row = value as Record<string, unknown>;
  if (
    typeof row.startupId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.startupId) ||
    !stages.includes(row.stage as StartupStage) ||
    !["started", "completed", "failed"].includes(String(row.status)) ||
    typeof row.elapsedMs !== "number" ||
    !Number.isFinite(row.elapsedMs) ||
    row.elapsedMs < 0 ||
    typeof row.durationMs !== "number" ||
    !Number.isFinite(row.durationMs) ||
    row.durationMs < 0
  )
    return;
  return {
    startupId: row.startupId,
    stage: row.stage as StartupStage,
    status: row.status as StartupTiming["status"],
    elapsedMs: row.elapsedMs,
    durationMs: row.durationMs,
  };
}

export class StartupTimer {
  readonly startupId: string;
  readonly origin: number;
  private readonly emit: (timing: StartupTiming) => void;

  constructor(
    startupId: string,
    emit: (timing: StartupTiming) => void,
    origin = performance.timeOrigin + performance.now(),
  ) {
    this.startupId = startupId;
    this.emit = emit;
    this.origin = origin;
  }

  start(stage: StartupStage): (failed?: boolean) => void {
    const started = performance.now();
    const write = (status: StartupTiming["status"], durationMs: number) =>
      this.emit({
        startupId: this.startupId,
        stage,
        status,
        elapsedMs: Math.max(
          0,
          Math.round(performance.timeOrigin + performance.now() - this.origin),
        ),
        durationMs: Math.max(0, Math.round(durationMs)),
      });
    write("started", 0);
    let finished = false;
    return (failed = false) => {
      if (finished) return;
      finished = true;
      write(failed ? "failed" : "completed", performance.now() - started);
    };
  }

  async measure<T>(stage: StartupStage, work: () => Promise<T>): Promise<T> {
    const finish = this.start(stage);
    try {
      const result = await work();
      finish();
      return result;
    } catch (error) {
      finish(true);
      throw error;
    }
  }
}

const startupId = process.env.AURA_DSH_STARTUP_ID;
const origin = Number(process.env.AURA_DSH_STARTUP_ORIGIN);
export const childStartup =
  startupId &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(startupId) &&
  Number.isFinite(origin) &&
  origin > 0
    ? new StartupTimer(
        startupId,
        (timing) =>
          process.stderr.write(
            `${STARTUP_TIMING_PREFIX}${JSON.stringify(timing)}\n`,
          ),
        origin,
      )
    : undefined;
