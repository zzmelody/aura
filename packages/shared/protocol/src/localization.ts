/** Static plugin display metadata, available without executing a page bundle. */
export const metadataLocales = ["zh-CN", "en", "ja", "ko", "ru", "fr"] as const;
export type MetadataCatalogs = Partial<
  Record<(typeof metadataLocales)[number], Record<string, string>>
>;

export interface SchemaTextKeys {
  titleKey?: string;
  descriptionKey?: string;
  placeholderKey?: string;
  /** Display labels in the original schema enum order; values never change. */
  enumKeys?: string[];
}

export interface ContributionTextKeys {
  titleKey?: string;
  descriptionKey?: string;
  /** JSON Pointer to a schema node, e.g. /properties/prompt or /items. */
  input?: Record<string, SchemaTextKeys>;
  output?: Record<string, SchemaTextKeys>;
}

export interface PluginLocalization {
  catalogs: MetadataCatalogs;
  nameKey?: string;
  descriptionKey?: string;
  /** Local contribution IDs, scoped to the declaring plugin. */
  flows?: Record<string, ContributionTextKeys>;
  actions?: Record<string, ContributionTextKeys>;
}

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fields = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const key = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !forbidden.has(value);

/** Bounded declarative data only; no paths to load, scripts, schema edits or values. */
export function isPluginLocalization(
  value: unknown,
): value is PluginLocalization {
  if (
    !record(value) ||
    !fields(value, [
      "catalogs",
      "nameKey",
      "descriptionKey",
      "flows",
      "actions",
    ]) ||
    !record(value.catalogs)
  )
    return false;
  const catalogs = value.catalogs;
  if (!record(catalogs.en)) return false;
  let size = 0;
  for (const [locale, catalog] of Object.entries(catalogs)) {
    if (
      !metadataLocales.some((entry) => entry === locale) ||
      !record(catalog) ||
      Object.keys(catalog).length > 2_000
    )
      return false;
    for (const [name, text] of Object.entries(catalog)) {
      if (
        !key(name) ||
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 4_000
      )
        return false;
      size += name.length + text.length;
      if (size > 256 * 1024) return false;
    }
  }
  const reference = (value: unknown) =>
    value === undefined ||
    (key(value) && Object.hasOwn(catalogs.en as object, value));
  const textKeys = (entry: Record<string, unknown>) =>
    reference(entry.titleKey) && reference(entry.descriptionKey);
  const schema = (value: unknown) => {
    if (value === undefined) return true;
    if (!record(value) || Object.keys(value).length > 256) return false;
    return Object.entries(value).every(
      ([pointer, entry]) =>
        pointer.length <= 1_024 &&
        (pointer === "" || pointer.startsWith("/")) &&
        !/~(?:[^01]|$)/u.test(pointer) &&
        record(entry) &&
        fields(entry, [
          "titleKey",
          "descriptionKey",
          "placeholderKey",
          "enumKeys",
        ]) &&
        textKeys(entry) &&
        reference(entry.placeholderKey) &&
        (entry.enumKeys === undefined ||
          (Array.isArray(entry.enumKeys) &&
            entry.enumKeys.length <= 256 &&
            entry.enumKeys.every((name) => key(name) && reference(name)))),
    );
  };
  if (!reference(value.nameKey) || !reference(value.descriptionKey))
    return false;
  for (const entries of [value.flows, value.actions]) {
    if (entries === undefined) continue;
    if (!record(entries) || Object.keys(entries).length > 128) return false;
    for (const [id, entry] of Object.entries(entries)) {
      if (
        !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(id) ||
        !record(entry) ||
        !fields(entry, ["titleKey", "descriptionKey", "input", "output"]) ||
        !textKeys(entry) ||
        !schema(entry.input) ||
        !schema(entry.output)
      )
        return false;
    }
  }
  return JSON.stringify(value).length <= 256 * 1024;
}
