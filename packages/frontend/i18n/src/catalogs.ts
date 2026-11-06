import { locales, type Locale } from "./locales.ts";

/** Flat semantic keys; plural variants use i18next's CLDR suffixes. */
export type MessageCatalog = Readonly<Record<string, string>>;
export type TranslationCatalogs = Partial<Record<Locale, MessageCatalog>>;

const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

/** Resource validation also protects the host from malformed plugin catalogs. */
export function validateCatalogs(value: unknown): TranslationCatalogs {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Translation catalogs must be an object.");
  const result: TranslationCatalogs = {};
  let count = 0;
  let size = 0;
  for (const [language, catalog] of Object.entries(value)) {
    if (!locales.some((locale) => locale === language))
      throw new Error("Unsupported translation language.");
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog))
      throw new Error("A translation catalog must be an object.");
    const messages: Record<string, string> = Object.create(null);
    for (const [key, message] of Object.entries(catalog)) {
      if (
        !key ||
        key.length > 200 ||
        forbiddenKeys.has(key) ||
        typeof message !== "string" ||
        !message.trim()
      )
        throw new Error("Invalid translation message.");
      size += key.length + message.length;
      if (++count > 50_000 || size > 5_000_000)
        throw new Error("Translation catalogs exceed the resource limit.");
      messages[key] = message;
    }
    result[language as Locale] = messages;
  }
  return result;
}

/** Expands text while leaving interpolation and markup intact for layout QA. */
export function pseudolocalize(catalog: MessageCatalog): MessageCatalog {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, message]) => [
      key,
      `[${message.replace(/\{\{.*?\}\}|<[^>]*>|[^<{]+/gu, (part) =>
        part.startsWith("{{") || part.startsWith("<")
          ? part
          : part.replace(/[aeiouAEIOU]/gu, (letter) => `${letter}ː`),
      )} ${"·".repeat(Math.ceil(message.length * 0.3))}]`,
    ]),
  );
}

export type { Locale } from "./locales.ts";
