import { language } from "@aura/i18n/runtime";

/** Retained after the startup surface is removed; never writes preferences. */
export function startDesktopLanguageBridge(): () => void {
  let last: string | undefined;
  const update = () => {
    const locale = language.getSnapshot().locale;
    const chrome = window.auraHost?.chrome;
    if (!chrome?.setLanguage || last === locale) return;
    last = locale;
    void chrome.setLanguage(locale).catch(() => {
      // A closing or unavailable native bridge must not prevent the UI loading.
      if (last === locale) last = undefined;
    });
  };
  const unsubscribe = language.subscribe(update);
  const dispose = () => {
    unsubscribe();
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  update();
  return dispose;
}
