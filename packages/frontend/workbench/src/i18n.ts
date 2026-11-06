/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { registerCatalogs } from "@aura/i18n/runtime";
import zhLanguage from "./locales/zh-CN/language.json" with { type: "json" };
import enLanguage from "./locales/en/language.json" with { type: "json" };
import jaLanguage from "./locales/ja/language.json" with { type: "json" };
import koLanguage from "./locales/ko/language.json" with { type: "json" };
import ruLanguage from "./locales/ru/language.json" with { type: "json" };
import frLanguage from "./locales/fr/language.json" with { type: "json" };
import zhNavigation from "./locales/zh-CN/navigation.json" with { type: "json" };
import enNavigation from "./locales/en/navigation.json" with { type: "json" };
import jaNavigation from "./locales/ja/navigation.json" with { type: "json" };
import koNavigation from "./locales/ko/navigation.json" with { type: "json" };
import ruNavigation from "./locales/ru/navigation.json" with { type: "json" };
import frNavigation from "./locales/fr/navigation.json" with { type: "json" };
import zhSettings from "./locales/zh-CN/settings.json" with { type: "json" };
import enSettings from "./locales/en/settings.json" with { type: "json" };
import jaSettings from "./locales/ja/settings.json" with { type: "json" };
import koSettings from "./locales/ko/settings.json" with { type: "json" };
import ruSettings from "./locales/ru/settings.json" with { type: "json" };
import frSettings from "./locales/fr/settings.json" with { type: "json" };

const cleanup = [
  registerCatalogs("language", {
    "zh-CN": zhLanguage,
    en: enLanguage,
    ja: jaLanguage,
    ko: koLanguage,
    ru: ruLanguage,
    fr: frLanguage,
  }),
  registerCatalogs("navigation", {
    "zh-CN": zhNavigation,
    en: enNavigation,
    ja: jaNavigation,
    ko: koNavigation,
    ru: ruNavigation,
    fr: frNavigation,
  }),
  registerCatalogs("settings", {
    "zh-CN": zhSettings,
    en: enSettings,
    ja: jaSettings,
    ko: koSettings,
    ru: ruSettings,
    fr: frSettings,
  }),
];
if (import.meta.hot)
  import.meta.hot.dispose(() => cleanup.forEach((dispose) => dispose()));

type HostCatalogs = {
  language: typeof enLanguage;
  navigation: typeof enNavigation;
  settings: typeof enSettings;
};
export type WorkbenchMessageKey<Namespace extends keyof HostCatalogs> =
  keyof HostCatalogs[Namespace] & string;

export function useWorkbenchMessages<Namespace extends keyof HostCatalogs>(
  namespace: Namespace,
) {
  return useMessages<WorkbenchMessageKey<Namespace>>(namespace);
}
