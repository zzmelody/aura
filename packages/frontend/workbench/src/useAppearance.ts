import { useLayoutEffect, useMemo, useState } from "react";
import {
  appearancePalette,
  appearanceVariables,
  defaultAppearance,
  normalizeAppearance,
  readAppearance,
  saveAppearance,
  type AppearancePreferences,
} from "./appearance.ts";

export function useAppearance(dark: boolean) {
  const [preferences, setPreferences] = useState(() => {
    try {
      return readAppearance(localStorage);
    } catch {
      // Accessing localStorage itself can fail in restricted browser contexts.
      return { ...defaultAppearance };
    }
  });
  const [saveError, setSaveError] = useState(false);
  const colors = useMemo(
    () => appearancePalette(dark, preferences),
    [dark, preferences],
  );
  const variables = useMemo(
    () => appearanceVariables(colors, preferences),
    [colors, preferences],
  );

  useLayoutEffect(() => {
    const style = document.documentElement.style;
    const previous = Object.keys(variables).map((key) => [
      key,
      style.getPropertyValue(key),
    ]);
    for (const [key, value] of Object.entries(variables))
      style.setProperty(key, value);
    return () => {
      for (const [key, value] of previous) {
        if (value) style.setProperty(key, value);
        else style.removeProperty(key);
      }
    };
  }, [variables]);

  function update(next: AppearancePreferences) {
    const normalized = normalizeAppearance(next);
    setPreferences(normalized);
    try {
      setSaveError(!saveAppearance(localStorage, normalized));
    } catch {
      setSaveError(true);
    }
  }

  return {
    preferences,
    colors,
    saveError,
    update,
    reset: () => update({ ...defaultAppearance }),
  };
}

export type AppearanceController = ReturnType<typeof useAppearance>;
