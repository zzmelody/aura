import type { ErrorTranslations } from "@aura/plugin-sdk/errors";
import { SiteStatusError } from "../shared/status-messages.ts";
import zh from "../client/src/locales/zh-CN.json" with { type: "json" };
import en from "../client/src/locales/en.json" with { type: "json" };
import ja from "../client/src/locales/ja.json" with { type: "json" };
import ko from "../client/src/locales/ko.json" with { type: "json" };
import ru from "../client/src/locales/ru.json" with { type: "json" };
import fr from "../client/src/locales/fr.json" with { type: "json" };

/** Reuse the plugin's own offline status resources at its page-operation boundary. */
export function siteErrorMessages(
  error: unknown,
): ErrorTranslations | undefined {
  if (!(error instanceof SiteStatusError)) return;
  const result = { en: "" } as ErrorTranslations;
  for (const [locale, catalog] of Object.entries({
    "zh-CN": zh,
    en,
    ja,
    ko,
    ru,
    fr,
  })) {
    const template = (catalog as Record<string, string>)[error.details.code];
    if (!template) return;
    const params = "params" in error.details ? error.details.params : {};
    const text = template.replace(
      /\{\{(\w+)\}\}/gu,
      (original, key: string) => {
        const value = (params as Record<string, unknown>)[key];
        return typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : original;
      },
    );
    if (text.includes("{{")) return;
    result[locale as keyof ErrorTranslations] = text;
  }
  return result;
}
