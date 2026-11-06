import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import type { TOptions } from "i18next";
import {
  language,
  languageStorageKey,
  type LanguageController,
} from "./runtime.ts";

const LanguageContext = createContext(language);

export function LanguageProvider({
  children,
  controller = language,
}: {
  children: ReactNode;
  controller?: LanguageController;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [failure, setFailure] = useState<{ error: unknown }>();
  useEffect(() => {
    document.documentElement.lang = state.locale;
    document.documentElement.dir = "ltr";
  }, [state.locale]);
  useEffect(() => {
    // Initialization errors are exceptional; ordinary preference storage errors
    // are exposed by the controller and announced next to the language setting.
    const report = (error: unknown) => {
      setFailure({ error });
    };
    void controller.ready.catch(report);
    const systemChanged = () => {
      void controller.systemChanged(navigator.languages).catch(report);
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === languageStorageKey || event.key === null)
        void controller.restore().catch(report);
    };
    window.addEventListener("languagechange", systemChanged);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("languagechange", systemChanged);
      window.removeEventListener("storage", storageChanged);
    };
  }, [controller]);
  if (failure) throw failure.error;
  return createElement(
    LanguageContext.Provider,
    { value: controller },
    createElement(I18nextProvider, { i18n: controller.i18n, children }),
  );
}

export function useLanguage() {
  const controller = useContext(LanguageContext);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { ...state, select: controller.select };
}

/** Also works in isolated component previews before a Provider is mounted. */
export function useMessages<Key extends string = string>(namespace: string) {
  const controller = useContext(LanguageContext);
  const messages = useTranslation(namespace, { i18n: controller.i18n });
  return {
    // Catalog validation guarantees flat string values. This narrows the keys
    // without replacing react-i18next's stable, language-bound t function.
    t: messages.t as (key: Key, options?: TOptions) => string,
    // Resource ownership and effect dependencies need the controller's stable
    // instance. react-i18next may return a new language-bound wrapper instead.
    i18n: controller.i18n,
    ready: messages.ready,
  };
}
