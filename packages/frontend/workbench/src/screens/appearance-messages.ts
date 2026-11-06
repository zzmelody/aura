import { useMessages } from "@aura/i18n";
import { registerCatalogs } from "@aura/i18n/runtime";
import zh from "../locales/zh-CN/appearance.json" with { type: "json" };
import en from "../locales/en/appearance.json" with { type: "json" };
import ja from "../locales/ja/appearance.json" with { type: "json" };
import ko from "../locales/ko/appearance.json" with { type: "json" };
import ru from "../locales/ru/appearance.json" with { type: "json" };
import fr from "../locales/fr/appearance.json" with { type: "json" };

const dispose = registerCatalogs("appearance", {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);

export function useAppearanceMessages() {
  return useMessages<keyof typeof en>("appearance");
}
