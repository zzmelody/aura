/**
 * Checks untrusted HTTP history, including the final prompt's length.
 * @param {unknown} value Parsed request messages.
 * @returns {value is import('./types.ts').ChatMessage[]} Whether the history is accepted.
 */
export function validateMessages(value) {
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
