import type { ChatMessage } from "./types.ts";

/** Checks untrusted HTTP history, including the final prompt's length. */
export function validateMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200)
    return false;
  return (
    value.every(
      (m) =>
        m &&
        ["user", "assistant"].includes(m.role) &&
        typeof m.text === "string" &&
        m.text.length <= 12000,
    ) &&
    value.at(-1).role === "user" &&
    value.at(-1).text.trim().length > 0 &&
    value.at(-1).text.length <= 4000
  );
}
