/** Version-one storage key; moving modules does not migrate or erase records. */
export const STORAGE_KEY = "aura.workspace.v1";

/** @returns {import('./types.ts').Workspace} An empty local workspace. */
export function initialState() {
  return {
    version: 1,
    theme: "dark",
    reduceMotion: false,
    endpoint: "",
    provider: "offline",
    sessions: [],
  };
}

/** @param {unknown} value A parsed value. @returns {value is Record<string, unknown>} Whether fields can be read. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Restores bounded v1 history and marks interrupted generation as stopped.
 * @param {unknown} value Parsed local storage.
 * @returns {import('./types.ts').Workspace} Sanitized local state.
 */
export function restoreState(value) {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions))
    return initialState();
  /** @type {import('./types.ts').Session[]} */
  const sessions = [];
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
    /** @type {import('./types.ts').Message[]} */
    const messages = [];
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
 * @param {string} input User-entered service address.
 * @returns {string | null} Normalized origin, or null for an invalid address.
 */
export function validateEndpoint(input) {
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
