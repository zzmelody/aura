import { metadataLocales } from "./localization.ts";

/** Plugin-owned literal messages. No templates, HTML, diagnostics or input values. */
export type ErrorTranslations = { en: string } & Partial<
  Record<(typeof metadataLocales)[number], string>
>;

export function readErrorTranslations(
  value: unknown,
): ErrorTranslations | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const source = value as Record<string, unknown>;
  if (typeof source.en !== "string" || !source.en.trim()) return;
  const messages: Partial<Record<(typeof metadataLocales)[number], string>> =
    {};
  let size = 0;
  for (const locale of metadataLocales) {
    const text = source[locale];
    if (text === undefined) continue;
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return;
    size += text.length;
    if (size > 12000) return;
    messages[locale] = text;
  }
  return { ...messages, en: source.en };
}
