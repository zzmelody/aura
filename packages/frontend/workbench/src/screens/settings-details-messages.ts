/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { registerCatalogs, type MessageReference } from "@aura/i18n/runtime";
import zh from "../locales/zh-CN/settingsDetails.json" with { type: "json" };
import en from "../locales/en/settingsDetails.json" with { type: "json" };
import ja from "../locales/ja/settingsDetails.json" with { type: "json" };
import ko from "../locales/ko/settingsDetails.json" with { type: "json" };
import ru from "../locales/ru/settingsDetails.json" with { type: "json" };
import fr from "../locales/fr/settingsDetails.json" with { type: "json" };

const dispose = registerCatalogs("settingsDetails", {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);

export function useSettingsDetailsMessages() {
  return useMessages<keyof typeof en>("settingsDetails");
}

export function detailMessage(
  key: keyof typeof en,
  values?: MessageReference["values"],
): MessageReference {
  return { namespace: "settingsDetails", key, ...(values ? { values } : {}) };
}
