/** Shared React Native / React Native Web design tokens. */
import type { TextStyle } from "react-native";

export const palettes = {
  dark: {
    background: "#0C0B10",
    surface: "#15131B",
    elevated: "#1D1926",
    border: "#302A3C",
    text: "#F3F0FA",
    secondary: "#B2AABD",
    muted: "#958B9F",
    accent: "#BDA1FF",
    primary: "#8052EA",
    primaryText: "#FFFFFF",
    soft: "#261D3C",
    input: "#19151F",
    success: "#A3CFB3",
    danger: "#FFACB3",
    glow: "#5E2CB0",
    user: "#302047",
  },
  light: {
    background: "#F7F5FA",
    surface: "#FFFFFF",
    elevated: "#F0EBF7",
    border: "#DED6E8",
    text: "#20152F",
    secondary: "#65586F",
    muted: "#776780",
    accent: "#6942B4",
    primary: "#6D40CD",
    primaryText: "#FFFFFF",
    soft: "#EBE2FA",
    input: "#F3EFF8",
    success: "#326849",
    danger: "#B13749",
    glow: "#D7C6F5",
    user: "#E9DFF9",
  },
} as const;
export type Palette = { [K in keyof typeof palettes.dark]: string };
export const fonts = {
  display: "Manrope_600SemiBold",
  body: "Manrope_400Regular",
  medium: "Manrope_500Medium",
  mono: "IBMPlexMono_400Regular",
};
export const type = {
  hero: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 46,
    letterSpacing: -1.3,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 34,
    letterSpacing: -0.6,
  },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 26 },
  small: { fontFamily: fonts.body, fontSize: 12, lineHeight: 20 },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    lineHeight: 16,
    letterSpacing: 1.8,
  },
} satisfies Record<string, TextStyle>;
export const motion = {
  press: 110,
  enter: 420,
  orbit: 24000,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};
export const spacing = { xs: 4, sm: 8, md: 12, lg: 20, xl: 28, xxl: 40 };
