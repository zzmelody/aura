import {
  usePluginTranslation,
  type CatalogKey,
  type TranslationCatalogs,
} from "@aura/plugin-ui";
import zh from "./locales/zh-CN.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import { readSiteMessage } from "../../shared/status-messages.ts";

export const translations = {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
} satisfies TranslationCatalogs;
export type SiteMessageKey = CatalogKey<typeof en>;

export function useSiteMessages() {
  return usePluginTranslation<SiteMessageKey>("site-launcher");
}

export function isSiteMessageKey(value: string): value is SiteMessageKey {
  return Object.hasOwn(en, value);
}

export function siteStatusText(
  value: unknown,
  fallback: string | undefined,
  t: ReturnType<typeof useSiteMessages>["t"],
): string | undefined {
  const detail = readSiteMessage(value);
  return detail
    ? t(detail.code, "params" in detail ? detail.params : undefined)
    : fallback;
}

export function sitePortText(
  value: unknown,
  fallback: string | undefined,
  t: ReturnType<typeof useSiteMessages>["t"],
): string | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 2)
    return fallback;
  const messages = value.map((item) => siteStatusText(item, undefined, t));
  return messages.every((text) => text !== undefined)
    ? messages.join(" ")
    : fallback;
}
