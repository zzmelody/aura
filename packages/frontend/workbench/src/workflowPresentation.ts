import type { Message } from "@aura/core/types";
import type { FlowRun, JsonValue } from "@aura/protocol/types";

/** Pair persisted input with its own run, never with a neighbouring execution. */
export function workflowExecutions(messages: Message[]) {
  const inputs = new Map(
    messages
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message]),
  );
  const attached = new Set(
    messages.flatMap((message) =>
      message.workflowRunId ? [`${message.workflowRunId}:input`] : [],
    ),
  );
  return messages
    .filter((message) => !attached.has(message.id))
    .map((message) => ({
      message,
      input: message.workflowRunId
        ? inputs.get(`${message.workflowRunId}:input`)
        : undefined,
    }));
}

export function storedWorkflowValue(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export function hasWorkflowContent(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object")
    return Object.values(value).some(hasWorkflowContent);
  return true;
}

/**
 * File locations and generator metadata can fold behind ready media. Keep
 * prose, warnings and other meaningful output visible.
 */
export function onlyFileReferences(
  value: JsonValue | undefined,
  key?: string,
): boolean {
  if (value === undefined || value === null) return true;
  if (key === "outputDirectory")
    return (
      typeof value === "string" && /^(?:[a-zA-Z]:[\\/]|\/)[^\n]+$/u.test(value)
    );
  if (key === "taskIds" && typeof value === "object" && !Array.isArray(value))
    return Object.values(value).every(
      (id) => typeof id === "string" && /^[\w-]+$/u.test(id),
    );
  // Generator metadata describes the file rather than adding new content.
  if (
    key &&
    /^(engine|model|service|seed|taskId|width|height|durationSeconds|imageModel|modelVersion|faceLimit|creditsConsumed|format)$/u.test(
      key,
    )
  )
    return typeof value !== "object";
  if (typeof value === "string")
    return (
      /^(?:[a-zA-Z]:[\\/]|\/)[^\n]*\.[a-zA-Z0-9]{2,5}$/u.test(value.trim()) ||
      // Content IDs of generated assets are references too.
      /^[a-f0-9]{64}$/u.test(value)
    );
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value))
    return value.every((item) => onlyFileReferences(item));
  return Object.entries(value).every(([field, item]) =>
    onlyFileReferences(item, field),
  );
}

export function workflowProgress(run: FlowRun | undefined) {
  const steps = run?.steps ?? [];
  return {
    completed: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    current: steps
      .filter((step) => step.status === "running")
      .map((step) => step.label),
  };
}

export function workflowDuration(start: number, finish: number): string {
  const seconds = Math.max(0, Math.floor((finish - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
