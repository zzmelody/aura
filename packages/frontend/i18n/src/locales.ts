export const locales = ["zh-CN", "en", "ja", "ko", "ru", "fr"] as const;
export type Locale = (typeof locales)[number];
export type LanguagePreference = Locale | "system";

export const languageNames: Readonly<Record<Locale, string>> = {
  "zh-CN": "简体中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  ru: "Русский",
  fr: "Français",
};

export function isLocale(value: unknown): value is Locale {
  return locales.some((locale) => locale === value);
}

export function isLanguagePreference(
  value: unknown,
): value is LanguagePreference {
  return value === "system" || isLocale(value);
}

/** Matches the full system preference list, including region/script variants. */
export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[],
): Locale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    try {
      const locale = new Intl.Locale(language);
      if (locale.language === "zh") return "zh-CN";
      if (isLocale(locale.language)) return locale.language;
    } catch {
      // Ignore an invalid platform language and try the next preference.
    }
  }
  return "en";
}
