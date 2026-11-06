import { Check, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { AppearanceController } from "../useAppearance.ts";
import { defaultAppearance } from "../appearance.ts";
import { useAppearanceMessages } from "./appearance-messages.ts";

const accents = [
  { name: "purple", color: "#8052EA", value: null },
  { name: "blue", color: "#3B82F6", value: "#3B82F6" },
  { name: "teal", color: "#14B8A6", value: "#14B8A6" },
  { name: "amber", color: "#F59E0B", value: "#F59E0B" },
  { name: "rose", color: "#F43F5E", value: "#F43F5E" },
] as const;

export function AppearanceSettings({
  appearance,
}: {
  appearance: AppearanceController;
}) {
  const { preferences, update } = appearance;
  const { t } = useAppearanceMessages();
  const [colorError, setColorError] = useState(false);
  const [hexDraft, setHexDraft] = useState<string>();
  const color = preferences.accent ?? accents[0].color;
  const customized =
    preferences.accent !== defaultAppearance.accent ||
    preferences.font !== defaultAppearance.font ||
    preferences.radius !== defaultAppearance.radius;

  return (
    <div className="settings-custom-appearance">
      <div className="settings-appearance-head">
        <div>
          <h3>{t("title")}</h3>
          <p>{t("hint")}</p>
        </div>
        <button
          type="button"
          className="tool-button"
          disabled={!customized && !appearance.saveError && !colorError}
          onClick={() => {
            setColorError(false);
            setHexDraft(undefined);
            appearance.reset();
          }}
        >
          <RotateCcw size={13} aria-hidden="true" />
          {t("reset")}
        </button>
      </div>
      <div className="settings-group">
        <div className="settings-row settings-row-stack">
          <div className="settings-row-copy">
            <strong id="appearance-accent-label">{t("accent")}</strong>
            <span>{t("accentHint")}</span>
          </div>
          <div className="settings-accent-controls">
            <div
              className="settings-accent-presets"
              role="group"
              aria-labelledby="appearance-accent-label"
            >
              {accents.map((accent) => (
                <button
                  key={accent.name}
                  type="button"
                  className="settings-accent-preset"
                  aria-label={t(accent.name)}
                  aria-pressed={preferences.accent === accent.value}
                  style={{ backgroundColor: accent.color }}
                  onClick={() => {
                    setColorError(false);
                    setHexDraft(undefined);
                    update({ ...preferences, accent: accent.value });
                  }}
                >
                  {preferences.accent === accent.value ? (
                    <Check
                      size={14}
                      aria-hidden="true"
                      color={
                        accent.name === "amber" || accent.name === "teal"
                          ? "#151517"
                          : "#FFFFFF"
                      }
                    />
                  ) : null}
                </button>
              ))}
            </div>
            <div className="settings-custom-color">
              <input
                type="color"
                aria-label={t("customAccent")}
                value={color}
                onChange={(event) => {
                  setColorError(false);
                  setHexDraft(undefined);
                  update({ ...preferences, accent: event.target.value });
                }}
              />
              <input
                className="settings-color-hex"
                aria-label={t("accentHex")}
                aria-invalid={colorError || undefined}
                aria-describedby={
                  colorError ? "appearance-color-error" : undefined
                }
                value={hexDraft ?? color}
                maxLength={7}
                spellCheck={false}
                onChange={(event) => {
                  setHexDraft(event.target.value);
                  setColorError(false);
                }}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (!/^#[\da-f]{6}$/iu.test(value)) {
                    setColorError(true);
                    return;
                  }
                  if (value.toUpperCase() !== color)
                    update({ ...preferences, accent: value });
                  setHexDraft(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </div>
          {colorError ? (
            <p
              id="appearance-color-error"
              className="settings-feedback error"
              role="alert"
            >
              {t("invalidHex")}
            </p>
          ) : null}
        </div>
        <div className="settings-row">
          <label className="settings-row-copy" htmlFor="appearance-font">
            <strong>{t("font")}</strong>
            <span>{t("fontHint")}</span>
          </label>
          <select
            id="appearance-font"
            value={preferences.font}
            onChange={(event) =>
              update({
                ...preferences,
                font:
                  event.target.value === "serif"
                    ? "serif"
                    : event.target.value === "mono"
                      ? "mono"
                      : "system",
              })
            }
          >
            <option value="system">{t("systemFont")}</option>
            <option value="serif">{t("serifFont")}</option>
            <option value="mono">{t("monoFont")}</option>
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong id="appearance-radius-label">{t("radius")}</strong>
            <span>{t("radiusHint")}</span>
          </span>
          <div
            className="settings-radius-options"
            role="group"
            aria-labelledby="appearance-radius-label"
          >
            {(
              [
                ["square", t("square")],
                ["default", t("default")],
                ["rounded", t("rounded")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={preferences.radius === value}
                onClick={() => update({ ...preferences, radius: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div
        className="settings-appearance-preview"
        role="group"
        aria-label={t("preview")}
      >
        <span className="settings-appearance-preview-caption">
          {t("livePreview")}
        </span>
        <span className="settings-appearance-sample">{t("sample")}</span>
        <p>{t("sampleHint")}</p>
        <span className="settings-appearance-preview-action">
          {t("sampleAction")}
        </span>
      </div>
      {appearance.saveError ? (
        <p className="settings-feedback error" role="alert">
          {t("saveError")}
        </p>
      ) : null}
    </div>
  );
}
