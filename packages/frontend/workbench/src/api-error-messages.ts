/// <reference types="vite/client" />
import { registerCatalogs, type MessageReference } from "@aura/i18n/runtime";
import {
  readErrorDetails,
  readFlowFailureDetails,
} from "@aura/protocol/errors";
import zh from "./locales/zh-CN/apiErrors.json" with { type: "json" };
import en from "./locales/en/apiErrors.json" with { type: "json" };
import ja from "./locales/ja/apiErrors.json" with { type: "json" };
import ko from "./locales/ko/apiErrors.json" with { type: "json" };
import ru from "./locales/ru/apiErrors.json" with { type: "json" };
import fr from "./locales/fr/apiErrors.json" with { type: "json" };

const dispose = registerCatalogs("apiErrors", {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);

/** Preserve a semantic reference for retained errors; old servers still supply message. */
export function apiErrorText(
  body: unknown,
  fallback: string | MessageReference,
): string | MessageReference {
  const details = readErrorDetails(body);
  if (details?.code === "plugin_failure")
    return {
      namespace: "pluginErrors",
      key: "failure",
      translations: details.params.translations,
    };
  if (
    details?.code === "flow_cycle" ||
    details?.code === "conversation_tools_missing"
  )
    return {
      namespace: "apiErrors",
      key: details.code,
      values:
        details.code === "flow_cycle"
          ? { ids: details.params.ids.join(" → ") }
          : { tools: details.params.tools.join(", ") },
    };
  if (
    details?.code === "json_not_serializable" ||
    details?.code === "json_too_large"
  )
    return {
      namespace: "apiErrors",
      key: details.code,
      values: {
        target: {
          namespace: "apiErrors",
          key: `validation_target_${details.params.target}`,
        },
        ...("limitBytes" in details.params
          ? { limitBytes: details.params.limitBytes }
          : {}),
      },
    };
  if (details?.code === "validation_failed") {
    const ref = (
      key: string,
      values?: MessageReference["values"],
    ): MessageReference => ({
      namespace: "apiErrors",
      key,
      ...(values ? { values } : {}),
    });
    let issues: string | MessageReference = "";
    for (const issue of details.params.issues) {
      const reason =
        issue.reason === "invalid_type" && issue.expected
          ? ref("validation_type_expected", { expected: issue.expected })
          : issue.limit !== undefined &&
              ["too_small", "too_big", "not_multiple_of"].includes(issue.reason)
            ? ref(
                `validation_${issue.reason}_limit${issue.inclusive === false ? "_exclusive" : ""}`,
                { limit: issue.limit },
              )
            : ref(`validation_${issue.reason}`);
      const line = ref("validation_issue", {
        path: issue.path || ref("validation_root"),
        reason,
      });
      issues = issues
        ? ref("validation_join", { left: issues, right: line })
        : line;
    }
    if (details.params.remaining)
      issues = ref("validation_join", {
        left: issues,
        right: ref("validation_more", { count: details.params.remaining }),
      });
    return ref("validation_failed", {
      target: ref(`validation_target_${details.params.target}`),
      issues,
    });
  }
  if (details)
    return {
      namespace: "apiErrors",
      key: details.code,
      ...("params" in details ? { values: details.params } : {}),
    };
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string" &&
    body.message
  )
    return body.message;
  return fallback;
}

/** Live Flow projection; unknown or historical failures retain their original text. */
export function flowFailureText(
  legacy: string,
  value: unknown,
): string | MessageReference {
  const details = readFlowFailureDetails(value);
  if (!details) return legacy;
  let failure = apiErrorText(details.failure, legacy);
  if (details.child)
    failure = {
      namespace: "apiErrors",
      key: "flow_child_failure",
      values: {
        id: details.child.id,
        phase: {
          namespace: "apiErrors",
          key: `flow_child_${details.child.phase}`,
        },
        reason: failure,
      },
    };
  return details.uncertainty
    ? {
        namespace: "apiErrors",
        key: "flow_failure_context",
        values: {
          failure,
          uncertainty: {
            namespace: "apiErrors",
            key:
              details.uncertainty === "agent_result_unknown"
                ? "flow_agent_result_unknown"
                : "flow_agent_records_unavailable",
          },
        },
      }
    : failure;
}
