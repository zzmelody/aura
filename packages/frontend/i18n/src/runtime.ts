import { createInstance, type i18n } from "i18next";
import {
  isLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type Locale,
} from "./locales.ts";
import { validateCatalogs, type TranslationCatalogs } from "./catalogs.ts";

export * from "./locales.ts";
export type { MessageCatalog, TranslationCatalogs } from "./catalogs.ts";

export const languageStorageKey = "aura.language.v1";
export interface LanguageStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LanguageState {
  preference: LanguagePreference;
  locale: Locale;
  saveError: boolean;
}

function readPreference(storage?: LanguageStorage): LanguagePreference {
  try {
    const value: unknown = JSON.parse(
      storage?.getItem(languageStorageKey) ?? "null",
    );
    if (
      value &&
      typeof value === "object" &&
      "language" in value &&
      isLanguagePreference(value.language)
    )
      return value.language;
  } catch {
    // Unavailable or damaged preferences must never prevent startup.
  }
  return "system";
}

/** One controller per renderer. Factories keep previews and tests isolated. */
export function createLanguageController(
  options: {
    storage?: LanguageStorage;
    languages?: readonly string[];
  } = {},
) {
  let languages = options.languages ?? [];
  const preference = readPreference(options.storage);
  let state: LanguageState = {
    preference,
    locale: resolveLocale(preference, languages),
    saveError: false,
  };
  const listeners = new Set<() => void>();
  const instance = createInstance();
  const ready = instance.init({
    initAsync: false,
    lng: state.locale,
    fallbackLng: "en",
    supportedLngs: ["zh-CN", "en", "ja", "ko", "ru", "fr"],
    load: "currentOnly",
    ns: [],
    defaultNS: "common",
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    resources: {},
    react: { useSuspense: false, bindI18nStore: "added removed" },
  });

  const emit = () => {
    for (const listener of listeners) listener();
  };
  // Translation resources are local and initialization is synchronous. Keep the
  // promise public so non-React hosts and tests can explicitly observe failures.
  async function update(next: LanguagePreference, persist: boolean) {
    await ready;
    const locale = resolveLocale(next, languages);
    // With bundled resources changeLanguage completes synchronously. Publishing
    // preference before its event lets both React subscriptions see one state.
    let saveError = false;
    if (persist) {
      try {
        if (!options.storage)
          throw new Error("Preference storage is unavailable.");
        options.storage.setItem(
          languageStorageKey,
          JSON.stringify({ language: next }),
        );
      } catch {
        saveError = true;
      }
    }
    state = { preference: next, locale, saveError };
    await instance.changeLanguage(locale);
    emit();
  }

  return {
    i18n: instance,
    ready,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select(value: unknown) {
      if (!isLanguagePreference(value))
        return Promise.reject(new Error("Unsupported language preference."));
      return update(value, true);
    },
    systemChanged(next: readonly string[]) {
      languages = next;
      return update(state.preference, false);
    },
    restore() {
      return update(readPreference(options.storage), false);
    },
  };
}

export type LanguageController = ReturnType<typeof createLanguageController>;

function browserStorage(): LanguageStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const language = createLanguageController({
  storage: browserStorage(),
  languages: typeof navigator === "undefined" ? [] : navigator.languages,
});

/** Adds a whole namespace and returns an ownership-aware cleanup function. */
const owners = new WeakMap<i18n, Map<string, symbol>>();
export function registerCatalogs(
  namespace: string,
  catalogs: TranslationCatalogs,
  instance: i18n = language.i18n,
): () => void {
  const checked = validateCatalogs(catalogs);
  let registrations = owners.get(instance);
  if (!registrations) owners.set(instance, (registrations = new Map()));
  const owner = Symbol(namespace);
  // Replacement drops removed keys and locales instead of merging stale data.
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"])
    if (instance.hasResourceBundle(locale, namespace))
      instance.removeResourceBundle(locale, namespace);
  registrations.set(namespace, owner);
  for (const [locale, messages] of Object.entries(checked))
    instance.addResourceBundle(locale, namespace, messages);
  return () => {
    if (registrations.get(namespace) !== owner) return;
    registrations.delete(namespace);
    for (const locale of Object.keys(checked))
      instance.removeResourceBundle(locale, namespace);
  };
}

export function pluginNamespace(pluginId: string): string {
  return `plugin.${pluginId}`;
}

export function formatDate(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
  locale = language.getSnapshot().locale,
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale = language.getSnapshot().locale,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale = language.getSnapshot().locale,
): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    value,
    unit,
  );
}
