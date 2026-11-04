import {
  CHAT_IMAGE_LIMIT,
  type ChatMessage,
  type ChatModelSelection,
} from "./types.ts";

/** Correlates steering with its DSH user-message event. */
export function isCodingSteerRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      value,
    )
  );
}

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
export function validateConversationHistory(
  value: unknown,
): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every((message: unknown) => {
      if (!message || typeof message !== "object") return false;
      const item = message as Record<string, unknown>;
      return (
        (item.role === "user" || item.role === "assistant") &&
        typeof item.text === "string" &&
        item.text.length <= 80_000 &&
        (item.images === undefined ||
          (item.role === "user" &&
            Array.isArray(item.images) &&
            item.images.length <= CHAT_IMAGE_LIMIT &&
            item.images.every(
              (id: unknown) =>
                typeof id === "string" && /^[a-f0-9]{64}$/u.test(id),
            )))
      );
    })
  );
}

/** Checks a legacy chat request, including the final prompt's length. */
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
