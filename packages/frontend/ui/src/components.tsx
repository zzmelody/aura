import React, { createContext, useContext, useId } from "react";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "./web.tsx";
import {
  fonts,
  motion,
  palettes,
  type as textType,
  type Palette,
} from "./theme.ts";

export const ThemeContext = createContext<{
  colors: Palette;
  dark: boolean;
  reduced: boolean;
}>({ colors: palettes.dark, dark: true, reduced: false });
export const useTheme = () => useContext(ThemeContext);

export function Label({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  const { colors } = useTheme();
  return (
    <Text style={[textType.label, { color: color ?? colors.muted }]}>
      {children}
    </Text>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
  active = false,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: active ? colors.soft : "transparent",
          opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Icon
        size={20}
        strokeWidth={1.7}
        color={active ? colors.accent : colors.secondary}
      />
    </Pressable>
  );
}

export function Button({
  children,
  onPress,
  icon: Icon = ArrowUpRight,
  secondary = false,
  disabled = false,
  compact = false,
  style,
}: {
  children: string;
  onPress: () => void;
  icon?: LucideIcon;
  secondary?: boolean;
  disabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, reduced } = useTheme();
  return (
    <View style={[style, { opacity: disabled ? 0.4 : 1 }]}>
      <Pressable
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          {
            minHeight: compact ? 44 : 54,
            backgroundColor: secondary ? colors.soft : colors.primary,
            transform: [{ scale: !reduced && pressed ? 0.975 : 1 }],
            transition: reduced
              ? undefined
              : `transform ${motion.press}ms ease, opacity ${motion.press}ms ease`,
          },
        ]}
      >
        <Text
          style={{
            fontFamily: fonts.medium,
            fontWeight: 500,
            fontSize: 14,
            color: secondary ? colors.accent : colors.primaryText,
          }}
        >
          {children}
        </Text>
        <Icon
          size={18}
          color={secondary ? colors.accent : colors.primaryText}
          strokeWidth={1.6}
        />
      </Pressable>
    </View>
  );
}

export function Reveal({
  children,
  delay = 0,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { reduced } = useTheme();
  return (
    <View
      className={reduced ? undefined : "aura-reveal"}
      style={[
        style,
        reduced
          ? undefined
          : {
              animationDelay: `${delay}ms`,
              animationDuration: `${motion.enter}ms`,
              animationTimingFunction: motion.easing,
            },
      ]}
    >
      {children}
    </View>
  );
}

export function AuraMark({ size = 30 }: { size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: size * 0.66,
          height: size * 0.66,
          borderWidth: 1.8,
          borderStyle: "solid",
          borderColor: colors.accent,
          borderRadius: size,
          transform: [{ rotateX: "45deg" }, { rotateZ: "-35deg" }],
        }}
      />
      <View
        style={{
          position: "absolute",
          width: size * 0.3,
          height: size * 0.3,
          borderRadius: size,
          backgroundColor: colors.accent,
        }}
      />
    </View>
  );
}

export function Orb({ compact = false }: { compact?: boolean }) {
  const { colors, dark, reduced } = useTheme();
  const id = useId().replace(/:/g, "");
  const size = compact ? 152 : 210;
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      style={{
        height: compact ? 126 : 200,
        width: "100%",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 360 220"
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <radialGradient id={`${id}glow`}>
            <stop
              offset="0"
              stopColor={colors.glow}
              stopOpacity={dark ? 0.52 : 0.8}
            />
            <stop offset="1" stopColor={colors.background} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse
          cx="180"
          cy="110"
          rx="150"
          ry="109"
          fill={`url(#${id}glow)`}
        />
        {[60, 95, 130, 165, 200, 235, 270, 305].map((x) => (
          <line
            key={x}
            x1={x}
            x2={x}
            y1="27"
            y2="193"
            stroke={colors.border}
            strokeWidth="0.5"
            opacity="0.5"
          />
        ))}
        {[40, 75, 110, 145, 180].map((y) => (
          <line
            key={y}
            x1="32"
            x2="328"
            y1={y}
            y2={y}
            stroke={colors.border}
            strokeWidth="0.5"
            opacity="0.5"
          />
        ))}
        <circle
          cx="180"
          cy="110"
          r="82"
          stroke={colors.border}
          strokeDasharray="2 8"
          fill="none"
        />
        <line x1="10" x2="24" y1="110" y2="110" stroke={colors.muted} />
        <line x1="336" x2="350" y1="110" y2="110" stroke={colors.muted} />
      </svg>
      <View
        className={reduced ? undefined : "aura-orbit"}
        style={{
          width: size,
          height: size,
          animationDuration: `${motion.orbit}ms`,
        }}
      >
        <svg width="100%" height="100%" viewBox="0 0 210 210">
          <defs>
            <radialGradient id={`${id}core`} cx="35%" cy="25%" r="80%">
              <stop
                offset="0"
                stopColor={dark ? "#E6D9FF" : "#E5D6FF"}
              />
              <stop offset="0.48" stopColor="#A076E7" />
              <stop
                offset="1"
                stopColor={dark ? "#361362" : "#633397"}
              />
            </radialGradient>
          </defs>
          <g transform="rotate(-30 105 105)">
            <ellipse
              cx="105"
              cy="105"
              rx="96"
              ry="38"
              fill="none"
              stroke={colors.accent}
              strokeWidth="0.8"
              opacity="0.7"
            />
            <ellipse
              cx="105"
              cy="105"
              rx="89"
              ry="32"
              fill="none"
              stroke={colors.accent}
              strokeWidth="0.5"
              opacity="0.4"
            />
          </g>
          <g transform="rotate(57 105 105)">
            <ellipse
              cx="105"
              cy="105"
              rx="74"
              ry="42"
              fill="none"
              stroke={colors.accent}
              strokeWidth="0.65"
              opacity="0.6"
            />
          </g>
          <circle cx="105" cy="105" r="37" fill={`url(#${id}core)`} />
          <circle
            cx="105"
            cy="105"
            r="42"
            fill="none"
            stroke={colors.accent}
            strokeWidth="0.4"
            opacity="0.8"
          />
          <circle cx="182" cy="58" r="3.5" fill={colors.accent} />
        </svg>
      </View>
    </View>
  );
}

export function SectionHeading({
  title,
  meta,
}: {
  title: string;
  meta?: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.sectionHeading}>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontWeight: 500,
          fontSize: 15,
          color: colors.text,
        }}
      >
        {title}
      </Text>
      {meta ? <Label>{meta}</Label> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  button: {
    paddingHorizontal: 20,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
});
