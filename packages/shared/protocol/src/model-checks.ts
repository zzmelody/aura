/** Transient, redacted results of explicitly requested model checks; never persisted. */
export const modelProbeFailures = [
  "timeout",
  "authentication",
  "permission",
  "not_found",
  "rate_limit",
  "empty_response",
  "unsupported",
  "request_failed",
] as const;
export type ModelProbeFailureCode = (typeof modelProbeFailures)[number];
export type ModelServiceCheck =
  | {
      code:
        "unchecked" | "key_required" | "discovery_failed" | "catalog_failed";
    }
  | { code: "models_synced" | "models_listed"; count: number }
  | { code: "probe_succeeded"; model: string; elapsedMs: number; reply: string }
  | { code: "probe_failed"; model: string; reason: ModelProbeFailureCode };

const integer = (value: unknown, limit: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= limit;
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;

/** Copy only declared fields; arbitrary response/error objects are never interpolation values. */
export function readModelServiceCheck(
  value: unknown,
): ModelServiceCheck | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  const { code } = candidate;
  if (
    code === "unchecked" ||
    code === "key_required" ||
    code === "discovery_failed" ||
    code === "catalog_failed"
  )
    return { code };
  if (
    (code === "models_synced" || code === "models_listed") &&
    integer(candidate.count, 1_000_000)
  )
    return { code, count: candidate.count };
  if (!text(candidate.model, 1_000)) return;
  if (
    code === "probe_succeeded" &&
    integer(candidate.elapsedMs, 86_400_000) &&
    text(candidate.reply, 80)
  )
    return {
      code,
      model: candidate.model,
      elapsedMs: candidate.elapsedMs,
      reply: candidate.reply,
    };
  if (
    code === "probe_failed" &&
    modelProbeFailures.some((reason) => reason === candidate.reason)
  )
    return {
      code,
      model: candidate.model,
      reason: candidate.reason as ModelProbeFailureCode,
    };
}
