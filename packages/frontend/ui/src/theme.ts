/** Shared React Web design tokens. */
/** Shared React Web design tokens. */
import type { TextStyle } from "./web.tsx";

export const palettes = {
  dark: {
    background: "#171719",
    surface: "#1E1E21",
    elevated: "#27272B",
    border: "#34343A",
    text: "#ECECF0",
    secondary: "#B5B5C0",
    muted: "#8D8D9A",
    accent: "#BDA1FF",
    primary: "#8052EA",
    primaryText: "#FFFFFF",
    soft: "#2C273B",
    input: "#202023",
    success: "#A3CFB3",
    danger: "#FFACB3",
    glow: "#5E2CB0",
    user: "#302B3C",
  },
  light: {
    background: "#FAFAF9",
    surface: "#FFFFFF",
    elevated: "#F0F0EE",
    border: "#E1E1E0",
    text: "#242427",
    secondary: "#62626C",
    muted: "#777780",
    accent: "#6942B4",
    primary: "#6D40CD",
    primaryText: "#FFFFFF",
    soft: "#EEEBF6",
    input: "#F4F4F2",
    success: "#326849",
    danger: "#B13749",
    glow: "#D7C6F5",
    user: "#EEEBF6",
  },
} as const;
export type Palette = { [K in keyof typeof palettes.dark]: string };
export const fonts = {
  display: '"Manrope", "Noto Sans SC", system-ui, sans-serif',
  body: '"Manrope", "Noto Sans SC", system-ui, sans-serif',
  medium: '"Manrope", "Noto Sans SC", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};
export const type = {
  hero: {
    fontFamily: fonts.display,
    fontSize: 28,
    fontWeight: 600,
    lineHeight: "38px",
    letterSpacing: -1.3,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 21,
    fontWeight: 600,
    lineHeight: "30px",
    letterSpacing: -0.6,
  },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: "23px" },
  small: { fontFamily: fonts.body, fontSize: 12, lineHeight: "20px" },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: "16px",
    letterSpacing: 1.1,
  },
} satisfies Record<string, TextStyle>;
export const motion = {
  press: 110,
  enter: 420,
  orbit: 24000,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
