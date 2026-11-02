/** Shared React Web design tokens. */
import type { TextStyle } from "./web.tsx";

const softWhite = "rgb(234, 235, 238)";

/**
 * Aura's purple palette: neutral surfaces, violet accents and purple primary
 * actions. Shared by both themes and every `var(--key)` consumer; DSH-inspired
 * layout choices do not change Aura's brand colors.
 */
export const palettes = {
  dark: {
    background: "rgb(21, 21, 23)",
    surface: "rgb(35, 35, 36)",
    elevated: "rgb(44, 44, 46)",
    border: "rgba(255, 255, 255, 0.16)",
    hairline: "rgba(255, 255, 255, 0.12)",
    text: softWhite,
    secondary: "rgb(198, 201, 207)",
    muted: "rgb(166, 170, 178)",
    caption: "rgb(129, 133, 140)",
    accent: "#BDA1FF",
    primary: "#8052EA",
    primaryText: "#FFFFFF",
    soft: "#2C273B",
    pressed: "rgba(189, 161, 255, 0.18)",
    input: "rgb(35, 35, 36)",
    sidebar: "rgb(27, 27, 28)",
    success: "rgb(74, 222, 128)",
    danger: "rgb(248, 113, 113)",
    warning: "rgb(251, 191, 36)",
    glow: "#5E2CB0",
    user: "#302B3C",
    tooltip: "rgb(67, 69, 74)",
    tooltipText: softWhite,
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
    accent: "#6942B4",
    primary: "#6D40CD",
    primaryText: "#FFFFFF",
    soft: "#EEEBF6",
    pressed: "rgba(105, 66, 180, 0.14)",
    input: "rgb(255, 255, 255)",
    sidebar: "rgb(249, 250, 251)",
    success: "rgb(22, 163, 74)",
    danger: "rgb(220, 38, 38)",
    warning: "rgb(217, 119, 6)",
    glow: "#D7C6F5",
    user: "#EEEBF6",
    tooltip: "rgb(44, 44, 46)",
    tooltipText: softWhite,
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
  body: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: 400,
    lineHeight: "22px",
  },
  small: {
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 400,
    lineHeight: "18px",
  },
  label: {
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 400,
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
