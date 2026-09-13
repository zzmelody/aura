import type { Message, Session, Workspace, WorkflowBinding } from "./types.ts";

/** Version-one storage key; moving modules does not migrate or erase records. */
export const STORAGE_KEY = "aura.workspace.v1";

/** Returns an empty local workspace. */
export function initialState(): Workspace {
  return {
    version: 1,
    theme: "dark",
    reduceMotion: false,
    endpoint: "",
    provider: "offline",
    sessions: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Restores bounded v1 history and marks interrupted generation as stopped.
 */
export function restoreState(value: unknown): Workspace {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions))
    return initialState();
  const sessions: Session[] = [];
  for (const s of value.sessions) {
    if (sessions.length === 100) break;
    if (
      !isRecord(s) ||
      typeof s.id !== "string" ||
      typeof s.title !== "string" ||
      typeof s.updatedAt !== "number" ||
      !Array.isArray(s.messages)
    )
      continue;
    const messages: Message[] = [];
    const binding = isRecord(s.workflow) ? s.workflow : undefined;
    const workflow: WorkflowBinding | undefined =
      binding &&
      typeof binding.id === "string" &&
      typeof binding.title === "string" &&
      typeof binding.endpoint === "string" &&
      validateEndpoint(binding.endpoint)
        ? {
            id: binding.id,
            title: binding.title,
            endpoint: validateEndpoint(binding.endpoint)!,
            ...(binding.inputSchema && typeof binding.inputSchema === "object"
              ? {
                  inputSchema:
                    binding.inputSchema as WorkflowBinding["inputSchema"],
                }
              : {}),
            ...(isRecord(binding.pending) &&
            typeof binding.pending.requestId === "string" &&
            (binding.pending.mode === "demo" ||
              binding.pending.mode === "codex") &&
            binding.pending.input !== undefined
              ? { pending: binding.pending as WorkflowBinding["pending"] }
              : {}),
          }
        : undefined;
    for (const m of s.messages) {
      if (
        !isRecord(m) ||
        typeof m.id !== "string" ||
        (m.role !== "user" && m.role !== "assistant") ||
        typeof m.text !== "string"
      )
        continue;
      messages.push({
        id: m.id,
        role: m.role,
        text: m.text,
        status:
          m.status === "streaming"
            ? "stopped"
            : m.status === "stopped" || m.status === "error"
              ? m.status
              : "complete",
        ...(workflow && typeof m.workflowRunId === "string"
          ? { workflowRunId: m.workflowRunId }
          : {}),
        ...(workflow &&
        typeof m.workflowPhase === "string" &&
        [
          "queued",
          "running",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(m.workflowPhase)
          ? { workflowPhase: m.workflowPhase as Message["workflowPhase"] }
          : {}),
      });
    }
    sessions.push({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messages: messages.slice(-200),
      ...(workflow ? { workflow } : {}),
    });
  }
  return {
    version: 1,
    theme:
      value.theme === "light" || value.theme === "system"
        ? value.theme
        : "dark",
    reduceMotion: value.reduceMotion === true,
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    provider:
      value.provider === "dsh" || value.provider === "codex"
        ? value.provider
        : "offline",
    sessions,
    ...(Array.isArray(value.hiddenWorkflowRuns)
      ? {
          hiddenWorkflowRuns: value.hiddenWorkflowRuns
            .filter((item): item is string => typeof item === "string")
            .slice(-500),
        }
      : {}),
  };
}

/**
 * Accepts an HTTP origin without embedded credentials, paths or query parameters.
 */
export function validateEndpoint(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    // URL parsing rejects malformed user-entered addresses.
    return null;
  }
}
