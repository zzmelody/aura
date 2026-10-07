/**
 * Deterministic model-ID helpers for OpenAI-compatible gateways such as
 * Lumina, whose `/models` listing names models but not their vendor or kind.
 */

const vendors: ReadonlyArray<[RegExp, string]> = [
  [/^claude-/u, "Anthropic"],
  [/^(gpt-|o\d|codex-|chatgpt-)/u, "OpenAI"],
  [/^gemini-|^gemma-/u, "Google"],
  [/^deepseek-/u, "DeepSeek"],
  [/^(qwen|qwq|wan)/u, "通义千问"],
  [/^glm-/u, "智谱"],
  [/^kimi-|^moonshot-/u, "Moonshot"],
  [/^minimax-|^abab/u, "MiniMax"],
  [/^(doubao-|seed)/u, "字节跳动"],
  [/^step-/u, "阶跃星辰"],
  [/^(grok-)/u, "xAI"],
  [/^(llama-|meta-)/u, "Meta"],
  [/^(mistral-|codestral-)/u, "Mistral"],
];

/** Display order of vendor groups; unknown vendors follow alphabetically. */
export const MODEL_VENDOR_ORDER = vendors
  .map(([, label]) => label)
  .filter((label, index, all) => all.indexOf(label) === index);

export const OTHER_MODEL_VENDOR = "其他";

export function modelVendor(id: string): string {
  const normalized = id.trim().toLowerCase();
  return (
    vendors.find(([pattern]) => pattern.test(normalized))?.[1] ??
    OTHER_MODEL_VENDOR
  );
}

/**
 * Gateway listings also carry embedding, rerank, image and routing aliases.
 * Only conversational models belong in a chat picker.
 */
export function isChatModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return !(
    /(^|-)(embedding|embed|rerank|tts|whisper|transcribe|moderation)(-|$)/u.test(
      normalized,
    ) ||
    /(^|-)image(-|$)|^gpt-image|^dall-e|^flux-|^midjourney|seedream|^wan\d/u.test(
      normalized,
    ) ||
    /^sub2api-|^all-proxy|auto-review$/u.test(normalized)
  );
}

/** Stable vendor grouping: known vendors in fixed order, models by ID inside. */
export function groupModelsByVendor<T extends { id: string; vendor?: string }>(
  models: readonly T[],
): Array<{ vendor: string; models: T[] }> {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const vendor = model.vendor ?? modelVendor(model.id);
    groups.set(vendor, [...(groups.get(vendor) ?? []), model]);
  }
  const rank = (vendor: string) => {
    const index = MODEL_VENDOR_ORDER.indexOf(vendor);
    return index < 0 ? MODEL_VENDOR_ORDER.length : index;
  };
  return [...groups.entries()]
    .sort(
      ([a], [b]) =>
        rank(a) - rank(b) ||
        Number(a === OTHER_MODEL_VENDOR) - Number(b === OTHER_MODEL_VENDOR) ||
        a.localeCompare(b),
    )
    .map(([vendor, items]) => ({
      vendor,
      models: [...items].sort((a, b) =>
        a.id.localeCompare(b.id, "en", { numeric: true }),
      ),
    }));
}
