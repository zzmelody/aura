/** Bounded presentation metadata only; no input values or validator messages. */
export const validationTargets = [
  "configuration",
  "flow_input",
  "flow_output",
  "action_input",
  "action_output",
  "agent_output",
  "child_input",
  "child_output",
  "memo_output",
  "submitted_result",
  "progress",
  "step_schema",
] as const;
export type ValidationTarget = (typeof validationTargets)[number];
const reasons = [
  "invalid_type",
  "too_small",
  "too_big",
  "invalid_format",
  "invalid_value",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "not_multiple_of",
] as const;
const expectedTypes = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
  "undefined",
  "bigint",
  "symbol",
  "function",
  "date",
  "int",
  "never",
] as const;
export interface ValidationIssue {
  path: string;
  reason: (typeof reasons)[number];
  expected?: string;
  limit?: number;
  inclusive?: boolean;
}
export interface ValidationParameters {
  target: ValidationTarget;
  issues: ValidationIssue[];
  remaining: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const pathText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 200 &&
  [...value].every(
    (char) =>
      /^[\p{L}\p{M}\p{N}_.$ -]$/u.test(char) || char === "[" || char === "]",
  );
const limitNumber = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= 1e12;

export function readValidationParameters(
  value: unknown,
): ValidationParameters | undefined {
  if (!record(value)) return;
  const target = validationTargets.find((item) => item === value.target);
  if (
    !target ||
    !Array.isArray(value.issues) ||
    !value.issues.length ||
    value.issues.length > 32 ||
    !Number.isSafeInteger(value.remaining) ||
    Number(value.remaining) < 0 ||
    Number(value.remaining) > 1e6
  )
    return;
  const issues: ValidationIssue[] = [];
  for (const item of value.issues) {
    if (!record(item) || !pathText(item.path)) return;
    const reason = reasons.find((code) => code === item.reason);
    if (!reason) return;
    const expected = expectedTypes.find((type) => type === item.expected);
    issues.push({
      path: item.path,
      reason,
      ...(expected ? { expected } : {}),
      ...(limitNumber(item.limit) ? { limit: item.limit } : {}),
      ...((reason === "too_small" || reason === "too_big") &&
      typeof item.inclusive === "boolean"
        ? { inclusive: item.inclusive }
        : {}),
    });
  }
  return { target, issues, remaining: Number(value.remaining) };
}

/** Read only structured validator discriminators; unknown/custom diagnostics stay legacy. */
export function validationParameters(
  issues: readonly unknown[],
  target: ValidationTarget = "configuration",
): ValidationParameters | undefined {
  if (
    issues.some(
      (item) =>
        !record(item) || !reasons.some((reason) => reason === item.code),
    )
  )
    return;
  const projected: ValidationIssue[] = [];
  for (const item of issues.slice(0, 32)) {
    if (!record(item) || !Array.isArray(item.path)) return;
    if (
      item.path.some(
        (part) =>
          typeof part !== "string" &&
          !(
            typeof part === "number" &&
            Number.isSafeInteger(part) &&
            part >= 0
          ),
      )
    )
      return;
    const path = item.path.join(".");
    const reason = reasons.find((code) => code === item.code);
    if (!reason || !pathText(path)) return;
    const expected = expectedTypes.find((type) => type === item.expected);
    const limit =
      reason === "too_small"
        ? item.minimum
        : reason === "too_big"
          ? item.maximum
          : reason === "not_multiple_of"
            ? item.divisor
            : undefined;
    projected.push({
      path,
      reason,
      ...(expected ? { expected } : {}),
      ...(limitNumber(limit) ? { limit } : {}),
      ...((reason === "too_small" || reason === "too_big") &&
      typeof item.inclusive === "boolean"
        ? { inclusive: item.inclusive }
        : {}),
    });
  }
  return readValidationParameters({
    target,
    issues: projected,
    remaining: Math.max(0, issues.length - 32),
  });
}
