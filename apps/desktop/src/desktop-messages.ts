/// <reference types="vite/client" />
import { language, registerCatalogs } from "@aura/i18n/runtime";
import zh from "./locales/zh-CN.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };

export const desktopCatalogs = { "zh-CN": zh, en, ja, ko, ru, fr };
export type DesktopMessageKey = keyof typeof en;

const dispose = registerCatalogs("desktop", desktopCatalogs);
if (import.meta.hot) import.meta.hot.dispose(dispose);

/** The main process and renderer own separate instances with the same catalogs. */
export function desktopText(
  key: DesktopMessageKey,
  instance = language.i18n,
): string {
  return instance.t(key, { ns: "desktop" });
}
