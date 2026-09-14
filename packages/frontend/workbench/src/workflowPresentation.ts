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
