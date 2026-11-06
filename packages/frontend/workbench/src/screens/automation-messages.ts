/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { registerCatalogs, type MessageReference } from "@aura/i18n/runtime";
import c0 from "../locales/zh-CN/automation.json" with { type: "json" };
import c1 from "../locales/en/automation.json" with { type: "json" };
import c2 from "../locales/ja/automation.json" with { type: "json" };
import c3 from "../locales/ko/automation.json" with { type: "json" };
import c4 from "../locales/ru/automation.json" with { type: "json" };
import c5 from "../locales/fr/automation.json" with { type: "json" };
const dispose = registerCatalogs("automation", {
  "zh-CN": c0,
  en: c1,
  ja: c2,
  ko: c3,
  ru: c4,
  fr: c5,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);
export type AutomationMessageKey = keyof typeof c1;
export function useAutomationMessages() {
  return useMessages<AutomationMessageKey>("automation");
}
export function automationMessage(key: AutomationMessageKey): MessageReference {
  return { namespace: "automation", key };
}
