/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { registerCatalogs, type MessageReference } from "@aura/i18n/runtime";
import zh from "../locales/zh-CN/integrations.json" with { type: "json" };
import en from "../locales/en/integrations.json" with { type: "json" };
import ja from "../locales/ja/integrations.json" with { type: "json" };
import ko from "../locales/ko/integrations.json" with { type: "json" };
import ru from "../locales/ru/integrations.json" with { type: "json" };
import fr from "../locales/fr/integrations.json" with { type: "json" };

const dispose = registerCatalogs("integrations", {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);

export type IntegrationMessageKey = keyof typeof en;

export function useIntegrationMessages() {
  return useMessages<IntegrationMessageKey>("integrations");
}

export function integrationMessage(
  key: IntegrationMessageKey,
): MessageReference {
  return { namespace: "integrations", key };
}
