import { fontStacks, palettes, type Palette } from "@aura/ui/theme";

export interface AppearancePreferences {
  accent: string | null;
  font: keyof typeof fontStacks;
  radius: "square" | "default" | "rounded";
}

export const defaultAppearance: Readonly<AppearancePreferences> = {
  accent: null,
  font: "system",
  radius: "default",
};

const storageKey = "aura.appearance.v1";
type AppearanceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function normalizeAppearance(value: unknown): AppearancePreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ...defaultAppearance };
  const source = value as Record<string, unknown>;
  return {
    accent:
      typeof source.accent === "string" && /^#[\da-f]{6}$/iu.test(source.accent)
        ? source.accent.toUpperCase()
        : null,
    font:
      source.font === "serif" || source.font === "mono"
        ? source.font
        : "system",
    radius:
      source.radius === "square" || source.radius === "rounded"
        ? source.radius
        : "default",
  };
}

export function readAppearance(
  storage: AppearanceStorage,
): AppearancePreferences {
  try {
    return normalizeAppearance(
      JSON.parse(storage.getItem(storageKey) ?? "null"),
    );
  } catch {
    // A damaged or unavailable preference store must not prevent startup.
    return { ...defaultAppearance };
  }
}

/** Only called for an explicit appearance edit or reset. */
export function saveAppearance(
  storage: AppearanceStorage,
  preferences: AppearancePreferences,
): boolean {
  const normalized = normalizeAppearance(preferences);
  try {
    if (
      normalized.accent === null &&
      normalized.font === "system" &&
      normalized.radius === "default"
    )
      storage.removeItem(storageKey);
    else storage.setItem(storageKey, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

type Rgb = [number, number, number];
function rgb(hex: string): Rgb {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  ) as Rgb;
}
function hex(color: Rgb): string {
  return `#${color
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}
function mix(color: Rgb, target: Rgb, amount: number): Rgb {
  return color.map((channel, index) =>
    Math.round(channel + (target[index] - channel) * amount),
  ) as Rgb;
}
function luminance(color: Rgb): number {
  const linear = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function readable(
  color: Rgb,
  backgrounds: Rgb[],
  target: Rgb,
  variants: (candidate: Rgb) => Rgb[] = (candidate) => [candidate],
): Rgb {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    // Leave a small margin for browser rounding when painting gradient stops.
    if (
      variants(candidate).every((variant) =>
        backgrounds.every((background) => contrast(variant, background) >= 4.6),
      )
    )
      return candidate;
  }
  return target;
}

export function appearancePalette(
  dark: boolean,
  preferences: AppearancePreferences,
): Palette {
  const base = dark ? palettes.dark : palettes.light;
  const accent = normalizeAppearance(preferences).accent;
  if (accent === null) return base;
  const color = rgb(accent);
  const background: Rgb = dark ? [21, 21, 23] : [255, 255, 255];
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  const elevated: Rgb = dark ? [44, 44, 46] : [249, 250, 251];
  const soft = mix(background, color, dark ? 0.18 : 0.1);
  const user = mix(background, color, dark ? 0.22 : 0.1);
  const glow = mix(background, color, dark ? 0.65 : 0.25);
  const textAccent = readable(
    color,
    [background, elevated, soft, user],
    dark ? white : black,
  );
  return {
    ...base,
    accent: hex(textAccent),
    primary: hex(
      readable(color, [white], black, (candidate) => [
        candidate,
        mix(candidate, glow, 0.14),
        mix(candidate, textAccent, 0.08),
      ]),
    ),
    soft: hex(soft),
    user: hex(user),
    glow: hex(glow),
    pressed: `rgba(${color.join(", ")}, ${dark ? 0.18 : 0.14})`,
  };
}

/** Document-level variables also reach dialogs mounted outside the workbench. */
export function appearanceVariables(
  colors: Palette,
  preferences: AppearancePreferences,
): Record<string, string> {
  const normalized = normalizeAppearance(preferences);
  return {
    ...Object.fromEntries(
      Object.entries(colors).map(([key, value]) => [`--${key}`, value]),
    ),
    "--font-text": fontStacks[normalized.font],
    "--font-mono": fontStacks.mono,
    "--radius-scale":
      normalized.radius === "square"
        ? "0"
        : normalized.radius === "rounded"
          ? "1.5"
          : "1",
  };
}
