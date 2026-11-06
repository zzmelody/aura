/// <reference types="vite/client" />
import { useMessages } from "@aura/i18n";
import { registerCatalogs } from "@aura/i18n/runtime";
import zh from "./locales/zh-CN/auth.json" with { type: "json" };
import en from "./locales/en/auth.json" with { type: "json" };
import ja from "./locales/ja/auth.json" with { type: "json" };
import ko from "./locales/ko/auth.json" with { type: "json" };
import ru from "./locales/ru/auth.json" with { type: "json" };
import fr from "./locales/fr/auth.json" with { type: "json" };

const dispose = registerCatalogs("auth", { "zh-CN": zh, en, ja, ko, ru, fr });
if (import.meta.hot) import.meta.hot.dispose(dispose);

export function useAuthMessages() {
  return useMessages<keyof typeof en>("auth");
}

export function isAuthMessageKey(value: string): value is keyof typeof en {
  return Object.hasOwn(en, value);
}
