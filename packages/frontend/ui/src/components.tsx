import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useId,
} from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  RadialGradient,
  Stop,
} from "react-native-svg";
import { ArrowUpRight, type LucideIcon } from "lucide-react-native";
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
      accessibilityRole="button"
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
  const scale = useRef(new Animated.Value(1)).current;
  const animate = (toValue: number) => {
    if (!reduced)
      Animated.timing(scale, {
        toValue,
        duration: motion.press,
        useNativeDriver: Platform.OS !== "web",
      }).start();
  };
  return (
    <Animated.View
      style={[style, { transform: [{ scale }], opacity: disabled ? 0.4 : 1 }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => animate(0.975)}
        onPressOut={() => animate(1)}
        style={[
          styles.button,
          {
            minHeight: compact ? 44 : 54,
            backgroundColor: secondary ? colors.soft : colors.primary,
          },
        ]}
      >
        <Text
          style={{
            fontFamily: fonts.medium,
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
    </Animated.View>
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
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.enter,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [delay, progress, reduced]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [12, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
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
  const angle = useRef(new Animated.Value(0)).current;
  const id = useId().replace(/:/g, "");
  useEffect(() => {
    if (reduced) {
      angle.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(angle, {
        toValue: 1,
        duration: motion.orbit,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [angle, reduced]);
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
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 360 220"
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <RadialGradient id={`${id}glow`}>
            <Stop
              offset="0"
              stopColor={colors.glow}
              stopOpacity={dark ? "0.52" : "0.8"}
            />
            <Stop offset="1" stopColor={colors.background} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Ellipse cx="180" cy="110" rx="150" ry="109" fill={`url(#${id}glow)`} />
        {[60, 95, 130, 165, 200, 235, 270, 305].map((x) => (
          <Line
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
          <Line
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
        <Circle
          cx="180"
          cy="110"
          r="82"
          stroke={colors.border}
          strokeDasharray="2 8"
          fill="none"
        />
        <Line x1="10" x2="24" y1="110" y2="110" stroke={colors.muted} />
        <Line x1="336" x2="350" y1="110" y2="110" stroke={colors.muted} />
      </Svg>
      <Animated.View
        style={{
          width: compact ? 152 : 210,
          height: compact ? 152 : 210,
          transform: [
            {
              rotate: angle.interpolate({
                inputRange: [0, 1],
                outputRange: ["0deg", "360deg"],
              }),
            },
          ],
        }}
      >
        <Svg width="100%" height="100%" viewBox="0 0 210 210">
          <Defs>
            <RadialGradient id={`${id}core`} cx="35%" cy="25%" r="80%">
              <Stop offset="0" stopColor={dark ? "#E6D9FF" : "#E5D6FF"} />
              <Stop offset="0.48" stopColor="#A076E7" />
              <Stop offset="1" stopColor={dark ? "#361362" : "#633397"} />
            </RadialGradient>
          </Defs>
          <G rotation="-30" origin="105, 105">
            <Ellipse
              cx="105"
              cy="105"
              rx="96"
              ry="38"
              fill="none"
              stroke={colors.accent}
              strokeWidth="0.8"
              opacity="0.7"
            />
            <Ellipse
              cx="105"
              cy="105"
              rx="89"
              ry="32"
              fill="none"
              stroke={colors.accent}
              strokeWidth="0.5"
              opacity="0.4"
            />
          </G>
          <G rotation="57" origin="105, 105">
            <Ellipse
              cx="105"
              cy="105"
              rx="74"
              ry="42"
              fill="none"
              stroke={colors.accent}
              strokeWidth="0.65"
              opacity="0.6"
            />
          </G>
          <Circle cx="105" cy="105" r="37" fill={`url(#${id}core)`} />
          <Circle
            cx="105"
            cy="105"
            r="42"
            fill="none"
            stroke={colors.accent}
            strokeWidth="0.4"
            opacity="0.8"
          />
          <Circle cx="182" cy="58" r="3.5" fill={colors.accent} />
        </Svg>
      </Animated.View>
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
        style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.text }}
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
