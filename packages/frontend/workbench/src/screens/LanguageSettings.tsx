import { useState } from "react";
import { useLanguage } from "@aura/i18n";
import { languageNames, locales } from "@aura/i18n/runtime";
import { useWorkbenchMessages } from "../i18n.ts";

export function LanguageSettings() {
  const { t } = useWorkbenchMessages("language");
  const { preference, saveError, select } = useLanguage();
  const [failed, setFailed] = useState(false);
  return (
    <div className="settings-group">
      <div className="settings-row settings-language-row">
        <div className="settings-row-copy">
          <label htmlFor="settings-language">{t("title")}</label>
          <span>{t("hint")}</span>
        </div>
        <div className="settings-row-control">
          <select
            id="settings-language"
            value={preference}
            onChange={(event) => {
              setFailed(false);
              void select(event.target.value).catch(() => setFailed(true));
            }}
          >
            <option value="system">{t("system")}</option>
            {locales.map((locale) => (
              <option key={locale} value={locale} lang={locale}>
                {languageNames[locale]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {saveError || failed ? (
        <div className="settings-row" role="alert">
          {t(failed ? "changeError" : "saveError")}
        </div>
      ) : null}
    </div>
  );
}
