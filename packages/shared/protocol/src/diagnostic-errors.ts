/** Public identifiers and source locations, never raw diagnostics or input values. */
export const diagnosticIdCodes = [
  "contribution_conflict",
  "action_missing",
  "flow_missing",
  "action_tool_conflict",
  "flow_service_missing",
  "flow_permission_missing",
  "flow_child_revision_missing",
  "flow_step_duplicate",
  "flow_scope_duplicate",
  "flow_replay_step",
  "flow_replay_action",
  "flow_preset_missing",
] as const;
export const diagnosticLimitCodes = [
  "flow_depth_limit",
  "flow_step_limit",
  "flow_agent_timeout",
] as const;
export type DiagnosticErrorDetails =
  | { code: (typeof diagnosticIdCodes)[number]; params: { id: string } }
  | { code: (typeof diagnosticLimitCodes)[number]; params: { limit: number } }
  | { code: "flow_cycle"; params: { ids: string[] } }
  | { code: "conversation_tools_missing"; params: { tools: string[] } }
  | { code: "action_execution_failed"; params: { id: string; reason: string } }
  | {
      code: "flow_source_promise";
      params: { line: number; method: string };
    }
  | {
      code: "flow_source_root";
      params: { line: number; context: string; operation: string };
    }
  | {
      code: "flow_model_config_unavailable";
      params: {
        reason: string;
        provider: string;
        model: string;
        effort: string;
      };
    };

const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,511}$/u.test(value) &&
  !value.includes("..");
const symbol = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z_$][\w$]{0,127}$/u.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readDiagnosticError(
  value: unknown,
): DiagnosticErrorDetails | undefined {
  if (!record(value) || !record(value.params)) return;
  const p = value.params;
  const idCode = diagnosticIdCodes.find((code) => code === value.code);
  if (idCode && identifier(p.id)) return { code: idCode, params: { id: p.id } };
  const limitCode = diagnosticLimitCodes.find((code) => code === value.code);
  if (
    limitCode &&
    typeof p.limit === "number" &&
    Number.isFinite(p.limit) &&
    p.limit > 0 &&
    p.limit <= 1e6
  )
    return { code: limitCode, params: { limit: p.limit } };
  for (const [code, key, max] of [
    ["flow_cycle", "ids", 10],
    ["conversation_tools_missing", "tools", 128],
  ] as const) {
    const list = p[key];
    if (
      value.code === code &&
      Array.isArray(list) &&
      list.length &&
      list.length <= max &&
      list.every(identifier)
    )
      return code === "flow_cycle"
        ? { code, params: { ids: [...list] } }
        : { code, params: { tools: [...list] } };
  }
  if (
    value.code === "action_execution_failed" &&
    identifier(p.id) &&
    typeof p.reason === "string" &&
    /^[A-Z0-9_]{1,100}$/u.test(p.reason)
  )
    return { code: value.code, params: { id: p.id, reason: p.reason } };
  if (
    Number.isSafeInteger(p.line) &&
    Number(p.line) > 0 &&
    Number(p.line) <= 1e7
  ) {
    if (
      value.code === "flow_source_promise" &&
      typeof p.method === "string" &&
      ["all", "allSettled", "race", "any"].includes(p.method)
    )
      return {
        code: value.code,
        params: { line: Number(p.line), method: p.method },
      };
    if (
      value.code === "flow_source_root" &&
      symbol(p.context) &&
      typeof p.operation === "string" &&
      ["agent", "action", "flow", "memo", "checkpoint", "parallel"].includes(
        p.operation,
      )
    )
      return {
        code: value.code,
        params: {
          line: Number(p.line),
          context: p.context,
          operation: p.operation,
        },
      };
  }
  if (
    value.code === "flow_model_config_unavailable" &&
    typeof p.reason === "string" &&
    /^[A-Z0-9_]{1,100}$/u.test(p.reason) &&
    identifier(p.provider) &&
    identifier(p.model) &&
    identifier(p.effort)
  )
    return {
      code: value.code,
      params: {
        reason: p.reason,
        provider: p.provider,
        model: p.model,
        effort: p.effort,
      },
    };
}
