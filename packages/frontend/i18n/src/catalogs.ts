import { locales, type Locale } from "./locales.ts";

/** Flat semantic keys; plural variants use i18next's CLDR suffixes. */
export type MessageCatalog = Readonly<Record<string, string>>;
export type TranslationCatalogs = Partial<Record<Locale, MessageCatalog>>;

type SingularKey<Key extends string> =
  Key extends `${infer Base}_${"zero" | "one" | "two" | "few" | "many" | "other"}`
    ? Base
    : Key;
export type CatalogKey<Catalog extends MessageCatalog> = SingularKey<
  keyof Catalog & string
>;

const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

const pluralKey = /^(.*)_(zero|one|two|few|many|other)$/u;
const placeholders = (message: string) =>
  [
    ...new Set(
      [...message.matchAll(/\{\{-?\s*([^},]+)(?:,[^}]*)?\}\}/gu)].map((match) =>
        match[1].trim(),
      ),
    ),
  ].sort();

/** Build-time audit; partial third-party catalogs can still use runtime fallback. */
export function auditCatalogs(
  catalogs: TranslationCatalogs,
  requiredLocales: readonly Locale[] = locales,
  referenceLocale: Locale = "en",
): string[] {
  validateCatalogs(catalogs);
  const reference = catalogs[referenceLocale];
  if (!reference) return [`Missing reference catalog: ${referenceLocale}`];
  const issues: string[] = [];
  const messages = new Map<string, boolean>();
  for (const key of Object.keys(reference)) {
    const plural = pluralKey.exec(key);
    messages.set(plural?.[1] ?? key, Boolean(plural));
  }
  for (const locale of requiredLocales) {
    const catalog = catalogs[locale];
    if (!catalog) {
      issues.push(`Missing catalog: ${locale}`);
      continue;
    }
    for (const [base, plural] of messages) {
      const keys = plural
        ? new Intl.PluralRules(locale)
            .resolvedOptions()
            .pluralCategories.map((category) => `${base}_${category}`)
        : [base];
      for (const key of keys) {
        if (!catalog[key]) {
          issues.push(`${locale}: missing ${key}`);
          continue;
        }
        const expected = reference[key] ?? reference[`${base}_other`];
        if (
          expected &&
          placeholders(catalog[key]).join("\n") !==
            placeholders(expected).join("\n")
        )
          issues.push(`${locale}: interpolation mismatch for ${key}`);
      }
    }
    for (const key of Object.keys(catalog)) {
      const base = pluralKey.exec(key)?.[1] ?? key;
      if (!messages.has(base)) issues.push(`${locale}: unexpected ${key}`);
    }
  }
  return issues;
}

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
