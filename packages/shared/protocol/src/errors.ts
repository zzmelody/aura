import {
  readDiagnosticError,
  type DiagnosticErrorDetails,
} from "./diagnostic-errors.ts";
import {
  readErrorTranslations,
  type ErrorTranslations,
} from "./error-translations.ts";
export {
  readErrorTranslations,
  type ErrorTranslations,
} from "./error-translations.ts";
import {
  readValidationParameters,
  validationTargets,
  type ValidationParameters,
  type ValidationTarget,
} from "./validation-errors.ts";
export {
  validationParameters,
  readValidationParameters,
  validationTargets,
} from "./validation-errors.ts";
export type {
  ValidationParameters,
  ValidationTarget,
} from "./validation-errors.ts";

/** A safe operation error that can cross an Aura host transport. */
export class FlowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Host-owned UI codes; unknown/plugin errors keep the existing message contract. */
export const apiErrorCodes = [
  "service_closing",
  "service_start_failed",
  "service_unavailable",
  "connection_interrupted",
  "image_not_found",
  "image_service_unavailable",
  "image_type_unsupported",
  "flow_request_invalid",
  "artifact_service_unavailable",
  "request_id_conflict",
  "flow_endpoint_not_found",
  "flow_request_failed",
  "coding_operation_failed",
  "conversation_unavailable",
  "terminal_operation_failed",
  "integration_unavailable",
  "conversation_request_invalid",
  "conversation_last_user_required",
  "conversation_service_busy",
  "chat_request_unavailable",
  "coding_request_unavailable",
  "runtime_request_failed",
  "conversation_receipt_missing",
  "conversation_service_closing",
  "conversation_command_conflict",
  "conversation_execution_active",
  "conversation_execution_ended",
  "conversation_admission_unsaved",
  "conversation_snapshot_updating",
  "conversation_events_expired",
  "conversation_command_invalid",
  "conversation_message_empty",
  "conversation_operation_failed",
  "conversation_result_unsaved",
  "conversation_host_restarted",
  "conversation_execution_stopped",
  "conversation_missing",
  "conversation_side_as_main",
  "conversation_closed",
  "conversation_project_mismatch",
  "conversation_parent_missing",
  "conversation_side_closed",
  "conversation_assistant_archive_forbidden",
  "conversation_assistant_close_forbidden",
  "conversation_assistant_delete_forbidden",
  "conversation_branch_conflict",
  "conversation_branch_source_required",
  "conversation_source_missing",
  "conversation_side_mismatch",
  "conversation_source_mismatch",
  "question_closed",
  "question_answer_invalid",
  "history_cursor_invalid",
  "model_output_limit",
  "model_budget_exceeded",
  "codex_refresh_failed",
  "model_execution_failed",
  "custom_model_unconfigured",
  "codex_max_tokens_unsupported",
  "conversation_policy_blocked",
  "subagent_output_limit",
  "subagent_record_unavailable",
  "workspace_default_unconfigured",
  "workspace_title_empty",
  "workspace_default_relocate_forbidden",
  "workspace_directory_taken",
  "workspace_default_remove_forbidden",
  "workspace_missing",
  "workspace_directory_required",
  "workspace_directory_absolute",
  "workspace_directory_missing",
  "workspace_required",
  "workspace_directory_invalid",
  "workspace_title_invalid",
  "workspace_invalid",
  "assistant_workspace_unavailable",
  "terminal_limit_reached",
  "terminal_exited",
  "terminal_close_confirmation",
  "terminal_request_invalid",
  "terminal_required",
  "terminal_input_missing",
  "capabilities_invalid",
  "web_key_invalid",
  "settings_revision_conflict",
  "title_request_exists",
  "extra_request_uncertain",
  "extra_request_budget_exhausted",
  "extra_request_reservation_missing",
  "collaboration_unavailable",
  "goal_stop_required",
  "goal_exists",
  "goal_not_resumable",
  "goal_round_limit",
  "integrations_invalid",
  "mcp_server_limit",
  "integrations_apply_failed",
  "voice_unavailable",
  "voice_model_required",
  "voice_transcription_active",
  "voice_transcription_failed",
  "agent_team_disabled",
  "session_search_unavailable",
  "automation_missing",
  "automation_conflict",
  "automation_invalid_prompt",
  "automation_invalid_rule",
  "automation_invalid_time_zone",
  "automation_not_future",
  "automation_time_out_of_range",
  "automation_frequency_too_high",
  "automation_subagent_session",
  "automation_invalid_selector",
  "conversation_command_query_invalid",
  "conversation_cursor_invalid",
  "voice_format_invalid",
  "search_query_invalid",
  "plugin_market_disabled",
  "conversation_mode_invalid",
  "subagent_invalid",
  "collaboration_request_invalid",
  "conversation_steer_invalid",
  "conversation_side_required",
  "permission_invalid",
  "automation_input_invalid",
  "assistant_request_invalid",
  "conversation_options_invalid",
  "conversation_steer_closed",
  "subagent_parent_invalid",
  "question_tool_unavailable",
  "conversation_parent_stopped",
  "mcp_tool_disabled",
  "mcp_permission_denied",
  "mcp_tool_failed",
  "goal_input_required",
  "subagent_disabled",
  "subagent_directory_mismatch",
  "web_configuration_required",
  "permissions_unavailable",
  "conversation_turn_busy",
  "collaboration_initial_required",
  "compaction_incomplete",
  "auto_compaction_incomplete",
  "conversation_title_fallback",
  "generation_stopped",
  "conversation_ended",
  "model_images_unsupported",
  "goal_text_required",
  "budget_service_unavailable",
  "fork_source_unavailable",
  "fork_turn_unavailable",
  "legacy_import_required",
  "model_service_change_forbidden",
  "model_question_empty",
  "goal_start_failed",
  "flow_run_missing",
  "flow_conversation_conflict",
  "flow_configured_model_forbidden",
  "flow_input_conflict",
  "flow_parent_revision_unavailable",
  "flow_parent_ended",
  "flow_child_request_mismatch",
  "flow_child_request_conflict",
  "flow_inline_forbidden",
  "flow_step_key_required",
  "flow_resolution_required",
  "flow_action_unexpected",
  "flow_command_conflict",
  "flow_ended",
  "flow_resume_invalid",
  "flow_pause_invalid",
  "flow_step_missing",
  "flow_child_resolution_required",
  "flow_checkpoint_not_waiting",
  "flow_resolution_not_waiting",
  "flow_step_session_unavailable",
  "flow_attempt_missing",
  "flow_attempt_invalid",
  "plugin_roots_duplicate",
  "plugin_reload_unavailable",
  "plugin_load_failed",
  "plugin_rollback_failed",
  "plugin_configuration_invalid",
  "flow_request_conflict",
  "artifact_not_found",
  "artifact_preview_unsupported",
  "artifact_file_unavailable",
  "artifact_thumbnail_unavailable",
  "flow_agent_failed",
  "flow_action_failed",
  "flow_code_failed",
  "flow_cancelled",
  "flow_agent_result_unknown",
  "flow_agent_records_unavailable",
  "flow_agent_output_invalid",
  "flow_timeout",
  "recovery_memo",
  "recovery_child",
  "recovery_action_unknown",
  "recovery_records_missing",
  "recovery_output",
  "recovery_agent_unknown",
  "recovery_records_unavailable",
  "recovery_retry",
  "recovery_exhausted",
  "recovery_restarted",
  "recovery_legacy",
  "recovery_agent_config",
  "recovery_revision",
  "recovery_parent_ended",
  "action_id_reserved",
  "action_timeout_invalid",
  "plugin_market_unavailable",
  "action_run_missing",
  "action_run_busy",
  "chat_tool_conflict",
  "step_schema_unsupported",
  "terminal_cursor_invalid",
  "plugin_http_entry_invalid",
  "plugin_http_mount_invalid",
  "plugin_http_mount_conflict",
  "plugin_http_factory_required",
  "plugin_rpc_forbidden",
  "plugin_http_fetch_required",
  "flow_agent_images_limit",
  "flow_agent_config_missing",
  "flow_agent_unavailable",
  "flow_agent_request_missing",
  "flow_agent_images_unsupported",
  "title_generation_failed",
  "flow_scope_closed",
  "flow_scope_serial",
  "flow_scope_unawaited",
  "flow_scope_checkpoint",
  "flow_scope_root",
  "flow_storage_unavailable",
  "flow_agent_actions_invalid",
  "flow_action_retry_forbidden",
  "flow_agent_config_invalid",
  "flow_memo_failed",
  "flow_replay_mismatch",
  "flow_directory_invalid",
  "action_directory_invalid",
  "flow_entry_invalid",
  "action_entry_invalid",
  "flow_definition_load_failed",
  "flow_definition_invalid",
  "action_definition_load_failed",
  "plugin_json_invalid",
  "plugin_entry_missing",
  "plugin_path_outside",
  "plugin_entry_empty",
  "plugin_contribution_missing",
  "plugin_contribution_layout",
  "plugin_contribution_id_invalid",
  "plugin_directory_missing",
  "plugin_manifest_invalid",
  "plugin_module_required",
  "plugin_aura_incompatible",
  "plugin_sdk_incompatible",
  "plugin_permission_unavailable",
  "plugin_legacy_entry_missing",
  "plugin_backend_required",
  "plugin_id_duplicate",
  "plugin_grant_conflict",
  "plugin_config_unreadable",
  "plugin_config_write_failed",
  "plugin_status_unavailable",
  "plugin_settings_local_only",
  "plugin_settings_too_large",
  "client_auth_expired",
  "ai_local_only",
  "ai_request_too_large",
  "ai_configuration_failed",
  "model_catalog_unavailable",
  "model_configuration_invalid",
  "integrations_local_only",
  "integrations_too_large",
  "integrations_json_invalid",
  "voice_prepare_local_only",
  "voice_recording_too_large",
  "plugin_page_too_large",
  "plugin_page_disabled",
  "plugin_operation_invalid",
  "auth_login_result_too_large",
  "auth_status_unavailable",
  "auth_login_confirming",
  "auth_device_unavailable",
  "auth_callback_port_busy",
  "auth_token_exchange_failed",
  "auth_callback_expired",
  "auth_code_missing",
  "auth_login_failed",
  "auth_result_invalid",
  "auth_no_pending_login",
  "ai_field_invalid",
  "ai_key_invalid",
  "ai_reasoning_invalid",
  "ai_custom_invalid",
  "ai_address_invalid",
  "ai_lumina_fixed",
  "ai_codex_key_forbidden",
  "ai_configuration_unreadable",
  "ai_configuration_invalid",
  "ai_custom_unsaved",
  "ai_busy_clear_key",
  "ai_lumina_settings_required",
  "ai_environment_key_readonly",
  "ai_key_required",
  "ai_busy_logout",
  "auth_login_start_failed",
  "auth_login_submit_failed",
] as const;

export type ApiErrorDetails =
  | { code: "plugin_failure"; params: { translations: ErrorTranslations } }
  | DiagnosticErrorDetails
  | { code: "validation_failed"; params: ValidationParameters }
  | { code: "json_not_serializable"; params: { target: ValidationTarget } }
  | {
      code: "json_too_large";
      params: { target: ValidationTarget; limitBytes: number };
    }
  | { code: (typeof apiErrorCodes)[number] }
  | { code: "model_codex_unsupported"; params: { model: string } }
  | { code: "model_selection_unavailable"; params: { reason: string } }
  | { code: "model_http_failed"; params: { status: number } }
  | { code: "image_too_large"; params: { limitMiB: number } }
  | { code: "flow_request_too_large"; params: { limitKiB: number } };

/** Display-only details for a Flow failure and its uncertainty warning. */
export interface FlowFailureDetails {
  failure: ApiErrorDetails;
  uncertainty?: "agent_result_unknown" | "agent_records_unavailable";
  child?: { id: string; phase: "failed" | "cancelled" | "interrupted" };
}

export function readFlowFailureDetails(
  value: unknown,
): FlowFailureDetails | undefined {
  if (!isRecord(value)) return;
  const failure = readErrorDetails(value.failure);
  if (!failure) return;
  const uncertainty = value.uncertainty;
  const child =
    isRecord(value.child) &&
    readDiagnosticError({
      code: "flow_missing",
      params: { id: value.child.id },
    }) &&
    (value.child.phase === "failed" ||
      value.child.phase === "cancelled" ||
      value.child.phase === "interrupted")
      ? {
          id: String(value.child.id),
          phase: value.child.phase as "failed" | "cancelled" | "interrupted",
        }
      : undefined;
  return {
    failure,
    ...(child ? { child } : {}),
    ...(uncertainty === "agent_result_unknown" ||
    uncertainty === "agent_records_unavailable"
      ? { uncertainty }
      : {}),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isLimit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 1_048_576;

/** Project only known codes and their bounded display parameters across RPC/HTTP. */
export function readErrorDetails(value: unknown): ApiErrorDetails | undefined {
  if (!isRecord(value)) return;
  const diagnostic = readDiagnosticError(value);
  if (diagnostic) return diagnostic;
  const code = apiErrorCodes.find((code) => code === value.code);
  if (code) return { code };
  if (!isRecord(value.params)) return;
  if (value.code === "plugin_failure") {
    const translations = readErrorTranslations(value.params.translations);
    if (translations) return { code: value.code, params: { translations } };
    return;
  }
  if (
    value.code === "json_not_serializable" ||
    value.code === "json_too_large"
  ) {
    const targetValue = value.params.target;
    const target = validationTargets.find((item) => item === targetValue);
    if (!target) return;
    if (value.code === "json_not_serializable")
      return { code: value.code, params: { target } };
    const limitBytes = value.params.limitBytes;
    if (
      typeof limitBytes === "number" &&
      Number.isSafeInteger(limitBytes) &&
      limitBytes > 0 &&
      limitBytes <= 1e12
    )
      return { code: value.code, params: { target, limitBytes } };
    return;
  }
  if (value.code === "validation_failed") {
    const params = readValidationParameters(value.params);
    if (params) return { code: value.code, params };
    return;
  }
  if (
    value.code === "model_codex_unsupported" &&
    typeof value.params.model === "string" &&
    /^[\w.-]{1,80}$/u.test(value.params.model)
  )
    return { code: value.code, params: { model: value.params.model } };
  if (
    value.code === "model_selection_unavailable" &&
    typeof value.params.reason === "string" &&
    /^[A-Z0-9_]{1,100}$/u.test(value.params.reason)
  )
    return { code: value.code, params: { reason: value.params.reason } };
  if (
    value.code === "model_http_failed" &&
    typeof value.params.status === "number" &&
    Number.isInteger(value.params.status) &&
    value.params.status >= 100 &&
    value.params.status <= 599
  )
    return { code: value.code, params: { status: value.params.status } };
  if (value.code === "image_too_large" && isLimit(value.params.limitMiB))
    return { code: value.code, params: { limitMiB: value.params.limitMiB } };
  if (value.code === "flow_request_too_large" && isLimit(value.params.limitKiB))
    return { code: value.code, params: { limitKiB: value.params.limitKiB } };
}

/** Transient presentation metadata; never used as a persisted Flow/Agent value. */
export class CodedFlowError extends FlowError {
  readonly details: ApiErrorDetails;

  constructor(message: string, status: number, details: ApiErrorDetails) {
    super(message, status);
    this.details = details;
  }
}

/** A plugin supplies its own bounded public translations without changing its legacy message. */
export class PluginFailure extends CodedFlowError {
  constructor(message: string, translations: ErrorTranslations, status = 400) {
    super(message, status, {
      code: "plugin_failure",
      params: { translations },
    });
  }
}

/** Keep the readable legacy message while excluding causes and arbitrary fields. */
export function flowErrorBody(
  error: FlowError,
): { message: string } & Partial<ApiErrorDetails> {
  return {
    message: error.message,
    ...(error instanceof CodedFlowError
      ? readErrorDetails(error.details)
      : undefined),
  };
}
