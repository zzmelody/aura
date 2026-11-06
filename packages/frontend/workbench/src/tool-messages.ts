/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { registerCatalogs, type MessageReference } from "@aura/i18n/runtime";
import c0 from "./locales/zh-CN/tools.json" with { type: "json" };
import c1 from "./locales/en/tools.json" with { type: "json" };
import c2 from "./locales/ja/tools.json" with { type: "json" };
import c3 from "./locales/ko/tools.json" with { type: "json" };
import c4 from "./locales/ru/tools.json" with { type: "json" };
import c5 from "./locales/fr/tools.json" with { type: "json" };
const dispose = registerCatalogs("tools", {
  "zh-CN": c0,
  en: c1,
  ja: c2,
  ko: c3,
  ru: c4,
  fr: c5,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);
export type ToolMessageKey = keyof typeof c1;
export function useToolMessages() {
  return useMessages<ToolMessageKey>("tools");
}
export function toolMessage(
  key: ToolMessageKey,
  values?: MessageReference["values"],
): MessageReference {
  return { namespace: "tools", key, ...(values ? { values } : {}) };
}
