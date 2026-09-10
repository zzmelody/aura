import type { Message, Session, Workspace } from "./types.ts";

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
    if (sessions.length === 60) break;
    if (
      !isRecord(s) ||
      typeof s.id !== "string" ||
      typeof s.title !== "string" ||
      typeof s.updatedAt !== "number" ||
      !Array.isArray(s.messages)
    )
      continue;
    const messages: Message[] = [];
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
      });
    }
    sessions.push({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messages: messages.slice(-200),
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
