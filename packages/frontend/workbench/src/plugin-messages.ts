/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { registerCatalogs, type MessageReference } from "@aura/i18n/runtime";
import zh from "./locales/zh-CN/plugins.json" with { type: "json" };
import en from "./locales/en/plugins.json" with { type: "json" };
import ja from "./locales/ja/plugins.json" with { type: "json" };
import ko from "./locales/ko/plugins.json" with { type: "json" };
import ru from "./locales/ru/plugins.json" with { type: "json" };
import fr from "./locales/fr/plugins.json" with { type: "json" };

const dispose = registerCatalogs("plugins", {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);

export type PluginMessageKey = keyof typeof en;

export function usePluginMessages() {
  return useMessages<PluginMessageKey>("plugins");
}

export function pluginMessage(
  key: PluginMessageKey,
  values?: MessageReference["values"],
): MessageReference {
  return { namespace: "plugins", key, ...(values ? { values } : {}) };
}
