import {
  CHAT_IMAGE_LIMIT,
  type ChatMessage,
  type ChatModelSelection,
} from "./types.ts";

/** Bounded model controls only; endpoint/provider/credentials are server-owned. */
export function validateChatModelSelection(
  value: unknown,
): value is ChatModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      (key === "model" || key === "reasoningEffort") &&
      typeof item === "string" &&
      item.trim() === item &&
      item.length > 0 &&
      item.length <= (key === "model" ? 200 : 80) &&
      // eslint-disable-next-line no-control-regex -- Intentionally sanitize or detect ASCII control characters.
      !/[\u0000-\u001f\u007f]/u.test(item),
  );
}

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
        m.text.length <= 12000 &&
        (m.images === undefined ||
          (m.role === "user" &&
            Array.isArray(m.images) &&
            m.images.length <= CHAT_IMAGE_LIMIT &&
            m.images.every(
              (id: unknown) =>
                typeof id === "string" && /^[a-f0-9]{64}$/u.test(id),
            ))),
    ) &&
    value.at(-1).role === "user" &&
    (value.at(-1).text.trim().length > 0 || value.at(-1).images?.length > 0) &&
    value.at(-1).text.length <= 4000
  );
}
