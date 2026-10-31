/** Shared React Web design tokens. */
import type { TextStyle } from "./web.tsx";

/**
 * Semantic palette following DSH desktop: blue-grey neutrals, a blue accent
 * and a near-black / near-white primary button. Keys stay Aura's, so every
 * `var(--key)` consumer keeps working.
 */
export const palettes = {
  dark: {
    background: "rgb(21, 21, 23)",
    surface: "rgb(35, 35, 36)",
    elevated: "rgb(44, 44, 46)",
    border: "rgba(255, 255, 255, 0.16)",
    hairline: "rgba(255, 255, 255, 0.12)",
    text: "rgb(249, 250, 251)",
    secondary: "rgb(207, 211, 214)",
    muted: "rgb(173, 178, 184)",
    caption: "rgb(129, 133, 140)",
    accent: "rgb(122, 170, 255)",
    primary: "rgb(249, 250, 251)",
    primaryText: "rgb(15, 17, 21)",
    soft: "rgba(255, 255, 255, 0.08)",
    pressed: "rgba(255, 255, 255, 0.14)",
    input: "rgb(35, 35, 36)",
    sidebar: "rgb(27, 27, 28)",
    success: "rgb(74, 222, 128)",
    danger: "rgb(248, 113, 113)",
    warning: "rgb(251, 191, 36)",
    glow: "rgb(41, 72, 140)",
    user: "rgb(44, 44, 46)",
    tooltip: "rgb(67, 69, 74)",
  },
  light: {
    background: "rgb(255, 255, 255)",
    surface: "rgb(255, 255, 255)",
    elevated: "rgb(249, 250, 251)",
    border: "rgba(0, 0, 0, 0.12)",
    hairline: "rgba(0, 0, 0, 0.10)",
    text: "rgb(15, 17, 21)",
    secondary: "rgb(97, 102, 107)",
    muted: "rgb(129, 133, 140)",
    caption: "rgb(173, 178, 184)",
    accent: "rgb(65, 118, 230)",
    primary: "rgb(15, 17, 21)",
    primaryText: "rgb(255, 255, 255)",
    soft: "rgba(38, 49, 72, 0.06)",
    pressed: "rgba(38, 49, 72, 0.10)",
    input: "rgb(255, 255, 255)",
    sidebar: "rgb(249, 250, 251)",
    success: "rgb(22, 163, 74)",
    danger: "rgb(220, 38, 38)",
    warning: "rgb(217, 119, 6)",
    glow: "rgb(228, 237, 253)",
    user: "rgb(242, 244, 247)",
    tooltip: "rgb(44, 44, 46)",
  },
} as const;
export type Palette = { [K in keyof typeof palettes.dark]: string };
const systemStack =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const fonts = {
  display: systemStack,
  body: systemStack,
  medium: systemStack,
  mono: "'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei', monospace",
};
export const type = {
  hero: {
    fontFamily: fonts.display,
    fontSize: 28,
    fontWeight: 600,
    lineHeight: "38px",
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 20,
    fontWeight: 500,
    lineHeight: "28px",
  },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: "22px" },
  small: { fontFamily: fonts.body, fontSize: 12, lineHeight: "18px" },
  label: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: "18px",
  },
} satisfies Record<string, TextStyle>;
export const motion = {
  press: 100,
  enter: 200,
  orbit: 24000,
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
};
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
/** DSH radius scale (px). */
export const radii = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, panel: 28 };
