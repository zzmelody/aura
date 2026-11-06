import { CodedFlowError, type ApiErrorDetails } from "@aura/protocol/errors";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FlowStep, FlowRunPhase, JsonValue } from "@aura/protocol/types";
import { jsonValue, parseJson } from "./schema.ts";

export class Suspension extends Error {
  readonly phase: "paused" | "waiting_input" | "needs_attention";
  constructor(phase: Suspension["phase"]) {
    super(phase);
    this.phase = phase;
  }
}
export class ReplayMismatch extends CodedFlowError {
  constructor(
    message: string,
    details: ApiErrorDetails = { code: "flow_replay_mismatch" },
  ) {
    super(`FLOW_REPLAY_MISMATCH: ${message}`, 409, details);
  }
}
export class StorageFailure extends Error {
  constructor(cause?: unknown) {
    // Expose only bounded OS error vocabulary, never paths, record values or
    // arbitrary backend messages (which may contain private workflow input).
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String(cause.code)
        : "";
    const detail =
      /^(?:EACCES|EPERM|ENOSPC|EIO|ENOENT|EBUSY|EMFILE|ENFILE|EROFS)$/u.test(
        code,
      )
        ? `（${code}）`
        : "";
    super(`Flow 状态提交失败${detail}；保留执行记录，恢复前请检查存储。`, {
      cause,
    });
  }
}
export const stable = (value: unknown): string => {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
export const stepKey = (step: FlowStep) => step.stepKey ?? step.id;
export const executable = (phase: FlowRunPhase) =>
  ["queued", "running", "pausing"].includes(phase);
export const terminal = (phase: FlowRunPhase) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(phase);
export const attemptsLeft = (step: FlowStep) =>
  (step.attempts?.length ?? 0) <
  (step.retry?.maxAttempts ?? 1) + (step.extraAttempts ?? 0);
export const retryAt = (step: FlowStep) =>
  Date.now() +
  Math.min(
    step.retry?.maxDelayMs ?? 30_000,
    (step.retry?.initialDelayMs ?? 1000) *
      (step.retry?.multiplier ?? 2) **
        Math.max(0, (step.attempts?.length ?? 1) - 1),
  );
// Zod 4.4 creates a fresh native length guard for every check. Compare the
// installed implementation, rather than function identity or just check names.
// This handles trusted plugin schemas, not arbitrary hostile JavaScript closures.
const functionSource = (value: unknown): string | undefined =>
  typeof value === "function"
    ? Function.prototype.toString.call(value)
    : undefined;
const nativeLengthConditions = new Map(
  z
    .string()
    .min(0)
    .max(1)
    .length(1)
    ._zod.def.checks!.map((check) => [
      check._zod.def.check,
      functionSource(check._zod.def.when),
    ]),
);
export function savedSchema(schema: z.ZodType): JsonValue {
  try {
    const snapshot = z.toJSONSchema(schema, {
      override: ({ zodSchema }) => {
        // Zod otherwise silently drops refinements/overwrites from JSON Schema.
        if (
          zodSchema._zod.def.checks?.some((check) => {
            const definition = check._zod.def;
            return (
              definition.check === "custom" ||
              definition.check === "overwrite" ||
              (definition.when !== undefined &&
                !(
                  (zodSchema._zod.def.type === "string" ||
                    zodSchema._zod.def.type === "array") &&
                  functionSource(definition.when) ===
                    nativeLengthConditions.get(definition.check)
                ))
            );
          })
        )
          throw new Error("Executable schema checks cannot be persisted.");
      },
    });
    const value = jsonValue(
      JSON.parse(JSON.stringify(snapshot)),
      "步骤 Schema",
    );
    // Validate round-trip support now, before a workflow can suspend on this schema.
    z.fromJSONSchema(value as Parameters<typeof z.fromJSONSchema>[0]);
    return value;
  } catch {
    throw new CodedFlowError(
      "步骤 Schema 必须可无损表示为受支持的 JSON Schema。",
      400,
      { code: "step_schema_unsupported" },
    );
  }
}
export function validateSaved(schema: JsonValue, value: unknown): JsonValue {
  const compiled = z.fromJSONSchema(
    schema as Parameters<typeof z.fromJSONSchema>[0],
  );
  return parseJson(compiled, value, "提交结果");
}

/** Admission of effectful calls; waiting callers re-check pause after acquisition. */
export class ConcurrencyGate {
  private count = 0;
  private waiters = new Set<() => void>();
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.count >= this.limit) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => {
          this.waiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        this.waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    signal.throwIfAborted();
    this.count++;
    return () => {
      this.count--;
      for (const wake of [...this.waiters]) wake();
    };
  }
}
