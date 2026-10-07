import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type ViewStyle = Record<string, unknown>;
export type TextStyle = Record<string, unknown>;
export type StyleProp<T = ViewStyle> =
  T | false | null | undefined | ReadonlyArray<StyleProp<T>>;

function flattenStyle(style: StyleProp): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style))
    return style.reduce<Record<string, unknown>>(
      (result, item) => Object.assign(result, flattenStyle(item)),
      {},
    );
  return style as Record<string, unknown>;
}

/** Converts Aura's compact layout vocabulary to ordinary DOM styles. */
export function resolveStyle(style: StyleProp): React.CSSProperties {
  const source = flattenStyle(style);
  const target: Record<string, unknown> = {};
  if (
    Object.keys(source).some(
      (key) => key === "borderWidth" || /^border.+Width$/.test(key),
    )
  )
    target.borderStyle = source.borderStyle ?? "solid";
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (key === "paddingHorizontal") {
      target.paddingLeft = value;
      target.paddingRight = value;
    } else if (key === "paddingVertical") {
      target.paddingTop = value;
      target.paddingBottom = value;
    } else if (key === "marginHorizontal") {
      target.marginLeft = value;
      target.marginRight = value;
    } else if (key === "marginVertical") {
      target.marginTop = value;
      target.marginBottom = value;
    } else if (key === "transform" && Array.isArray(value)) {
      target.transform = value
        .flatMap((entry) =>
          Object.entries(entry as Record<string, unknown>).map(
            ([operation, amount]) => `${operation}(${String(amount)})`,
          ),
        )
        .join(" ");
    } else if (key === "textAlignVertical") {
      continue;
    } else if (!key.startsWith("shadow") && key !== "elevation") {
      target[key] = value;
    }
  }
  return target as React.CSSProperties;
}

export const StyleSheet = {
  hairlineWidth: 1,
  absoluteFill: { position: "absolute", inset: 0 } satisfies ViewStyle,
  create<T extends Record<string, ViewStyle>>(styles: T): T {
    return styles;
  },
};

interface AccessibilityProps {
  accessibilityElementsHidden?: boolean;
  accessibilityLabel?: string;
  accessibilityLiveRegion?: "none" | "polite" | "assertive";
  accessibilityRole?: string;
  accessibilityState?: {
    checked?: boolean;
    disabled?: boolean;
    selected?: boolean;
  };
  accessible?: boolean;
}

function accessibility(props: AccessibilityProps) {
  const state = props.accessibilityState;
  return {
    "aria-checked": state?.checked,
    "aria-disabled": state?.disabled,
    "aria-hidden": props.accessibilityElementsHidden || undefined,
    "aria-label": props.accessibilityLabel,
    "aria-live":
      props.accessibilityLiveRegion === "none"
        ? undefined
        : props.accessibilityLiveRegion,
    "aria-selected": state?.selected,
    role:
      props.accessibilityRole === "none" ? undefined : props.accessibilityRole,
  };
}

export interface ViewProps
  extends
    Omit<React.HTMLAttributes<HTMLDivElement>, "style">,
    AccessibilityProps {
  style?: StyleProp<ViewStyle>;
}

export const View = forwardRef<HTMLDivElement, ViewProps>(function View(
  {
    accessibilityElementsHidden,
    accessibilityLabel,
    accessibilityLiveRegion,
    accessibilityRole,
    accessibilityState,
    accessible,
    style,
    ...props
  },
  ref,
) {
  return (
    <div
      {...props}
      {...accessibility({
        accessibilityElementsHidden,
        accessibilityLabel,
        accessibilityLiveRegion,
        accessibilityRole,
        accessibilityState,
        accessible,
      })}
      ref={ref}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        position: "relative",
        ...resolveStyle(style),
      }}
    />
  );
});

interface TextProps
  extends
    Omit<React.HTMLAttributes<HTMLSpanElement>, "style">,
    AccessibilityProps {
  numberOfLines?: number;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
}

export const Text = forwardRef<HTMLSpanElement, TextProps>(function Text(
  {
    accessibilityLabel,
    accessibilityLiveRegion,
    accessibilityRole,
    accessibilityState,
    numberOfLines,
    selectable,
    style,
    ...props
  },
  ref,
) {
  return (
    <span
      {...props}
      {...accessibility({
        accessibilityLabel,
        accessibilityLiveRegion,
        accessibilityRole,
        accessibilityState,
      })}
      ref={ref}
      style={{
        display: "block",
        ...(numberOfLines === 1
          ? {
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }
          : {}),
        ...(selectable === false ? { userSelect: "none" } : {}),
        ...resolveStyle(style),
      }}
    />
  );
});

type PressableState = { pressed: boolean };
interface PressableProps
  extends
    Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "style">,
    AccessibilityProps {
  children?: React.ReactNode | ((state: PressableState) => React.ReactNode);
  disabled?: boolean;
  onPress?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  style?:
    StyleProp<ViewStyle> | ((state: PressableState) => StyleProp<ViewStyle>);
}

export const Pressable = forwardRef<HTMLDivElement, PressableProps>(
  function Pressable(
    {
      accessibilityLabel,
      accessibilityRole = "button",
      accessibilityState,
      children,
      className,
      disabled = false,
      onKeyDown,
      onPointerDown,
      onPointerLeave,
      onPointerUp,
      onPress,
      onPressIn,
      onPressOut,
      style,
      ...props
    },
    ref,
  ) {
    const [pressed, setPressed] = useState(false);
    const currentStyle =
      typeof style === "function" ? style({ pressed }) : style;
    return (
      <div
        {...props}
        {...accessibility({
          accessibilityLabel,
          accessibilityRole,
          accessibilityState: { ...accessibilityState, disabled },
        })}
        className={`aura-pressable${className ? ` ${className}` : ""}`}
        onClick={(event) => {
          if (!disabled) onPress?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (
            !event.defaultPrevented &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            if (!disabled)
              onPress?.(event as unknown as React.MouseEvent<HTMLDivElement>);
          }
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (!disabled) {
            setPressed(true);
            onPressIn?.();
          }
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          if (pressed) {
            setPressed(false);
            onPressOut?.();
          }
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          setPressed(false);
          onPressOut?.();
        }}
        ref={ref}
        tabIndex={disabled ? -1 : 0}
        style={{
          cursor: disabled ? "not-allowed" : "pointer",
          userSelect: "none",
          ...resolveStyle(currentStyle),
        }}
      >
        {typeof children === "function" ? children({ pressed }) : children}
      </div>
    );
  },
);

export interface ScrollViewHandle {
  scrollToEnd(options?: { animated?: boolean }): void;
}
export type ScrollView = ScrollViewHandle;
interface ScrollViewProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "onScroll" | "style"
> {
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardShouldPersistTaps?: string;
  onContentSizeChange?: () => void;
  onScroll?: (event: {
    nativeEvent: {
      contentOffset: { x: number; y: number };
      contentSize: { width: number; height: number };
      layoutMeasurement: { width: number; height: number };
    };
  }) => void;
  scrollEventThrottle?: number;
  showsVerticalScrollIndicator?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const ScrollView = forwardRef<ScrollViewHandle, ScrollViewProps>(
  function ScrollView(
    {
      children,
      className,
      contentContainerStyle,
      keyboardShouldPersistTaps,
      onContentSizeChange,
      onScroll,
      scrollEventThrottle,
      showsVerticalScrollIndicator = true,
      style,
      ...props
    },
    forwardedRef,
  ) {
    const viewport = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    useImperativeHandle(forwardedRef, () => ({
      scrollToEnd: ({ animated = true } = {}) =>
        viewport.current?.scrollTo({
          top: viewport.current.scrollHeight,
          behavior: animated ? "smooth" : "auto",
        }),
    }));
    useLayoutEffect(() => {
      onContentSizeChange?.();
      if (
        !content.current ||
        !onContentSizeChange ||
        !globalThis.ResizeObserver
      )
        return;
      const observer = new ResizeObserver(onContentSizeChange);
      observer.observe(content.current);
      return () => observer.disconnect();
    }, [children, onContentSizeChange]);
    return (
      <div
        {...props}
        className={`aura-scroll${showsVerticalScrollIndicator ? "" : " aura-scroll--hidden"}${className ? ` ${className}` : ""}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          onScroll?.({
            nativeEvent: {
              contentOffset: { x: element.scrollLeft, y: element.scrollTop },
              contentSize: {
                width: element.scrollWidth,
                height: element.scrollHeight,
              },
              layoutMeasurement: {
                width: element.clientWidth,
                height: element.clientHeight,
              },
            },
          });
        }}
        ref={viewport}
        style={{
          flex: 1,
          minHeight: 0,
          overflowX: "hidden",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          ...resolveStyle(style),
        }}
      >
        <div
          ref={content}
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            ...resolveStyle(contentContainerStyle),
          }}
        >
          {children}
        </div>
      </div>
    );
  },
);

export type TextInput = HTMLInputElement | HTMLTextAreaElement;
interface TextInputProps
  extends
    Omit<
      React.InputHTMLAttributes<HTMLInputElement>,
      "autoCorrect" | "onChange" | "onKeyDown" | "style"
    >,
    AccessibilityProps {
  autoCorrect?: boolean;
  editable?: boolean;
  keyboardType?: string;
  multiline?: boolean;
  onChangeText?: (value: string) => void;
  onKeyPress?: (event: {
    nativeEvent: { key: string; shiftKey: boolean; isComposing: boolean };
    preventDefault(): void;
  }) => void;
  onSubmitEditing?: () => void;
  placeholderTextColor?: string;
  secureTextEntry?: boolean;
  selectionColor?: string;
  style?: StyleProp<TextStyle>;
}

export const TextInput = forwardRef<TextInput, TextInputProps>(
  function TextInput(
    {
      accessibilityLabel,
      autoCorrect,
      editable = true,
      keyboardType,
      multiline = false,
      onChangeText,
      onKeyPress,
      onSubmitEditing,
      placeholderTextColor,
      secureTextEntry,
      selectionColor,
      style,
      ...props
    },
    ref,
  ) {
    const element = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => element.current!);
    const common = {
      ...props,
      "aria-label": accessibilityLabel,
      autoCorrect: autoCorrect ? ("on" as const) : ("off" as const),
      className: "aura-input",
      disabled: !editable || props.disabled,
      onChange: (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => onChangeText?.(event.target.value),
      onKeyDown: (
        event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        onKeyPress?.({
          nativeEvent: {
            key: event.key,
            shiftKey: event.shiftKey,
            isComposing: event.nativeEvent.isComposing,
          },
          preventDefault: () => event.preventDefault(),
        });
        if (!multiline && event.key === "Enter" && !event.defaultPrevented)
          onSubmitEditing?.();
      },
      style: {
        "--aura-placeholder": placeholderTextColor,
        appearance: "none",
        borderStyle: "solid",
        caretColor: selectionColor,
        outline: "none",
        resize: multiline ? ("none" as const) : undefined,
        width: "100%",
        ...resolveStyle(style),
      } as React.CSSProperties,
    };
    return multiline ? (
      <textarea
        {...(common as React.TextareaHTMLAttributes<HTMLTextAreaElement>)}
        ref={element as React.RefObject<HTMLTextAreaElement>}
      />
    ) : (
      <input
        {...(common as React.InputHTMLAttributes<HTMLInputElement>)}
        ref={element as React.RefObject<HTMLInputElement>}
        type={secureTextEntry ? "password" : props.type}
      />
    );
  },
);

export function ActivityIndicator({
  color = "currentColor",
}: {
  color?: string;
  size?: "small" | "large";
}) {
  return (
    <span
      aria-hidden
      className="aura-spinner"
      style={{ borderTopColor: color }}
    />
  );
}

export function Switch({
  accessibilityLabel,
  disabled,
  onValueChange,
  thumbColor,
  trackColor,
  value,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  onValueChange?: (value: boolean) => void;
  thumbColor?: string;
  trackColor?: { false?: string; true?: string };
  value?: boolean;
}) {
  return (
    <button
      aria-label={accessibilityLabel}
      aria-checked={value}
      className="aura-switch"
      disabled={disabled}
      onClick={() => onValueChange?.(!value)}
      role="switch"
      style={{
        background: value ? trackColor?.true : trackColor?.false,
        opacity: disabled ? 0.5 : 1,
      }}
      type="button"
    >
      <span
        style={{
          background: thumbColor,
          transform: `translateX(${value ? 18 : 0}px)`,
        }}
      />
    </button>
  );
}

export function Modal({
  children,
  onRequestClose,
  visible,
}: {
  animationType?: string;
  children: React.ReactNode;
  onRequestClose?: () => void;
  transparent?: boolean;
  visible: boolean;
}) {
  useEffect(() => {
    if (!visible) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onRequestClose?.();
    };
    document.addEventListener("keydown", close);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", close);
      document.body.style.overflow = overflow;
    };
  }, [onRequestClose, visible]);
  if (!visible) return null;
  return createPortal(
    <div className="aura-modal">{children}</div>,
    document.body,
  );
}

export const Platform = { OS: "web" as const };

export function useWindowDimensions() {
  const [size, setSize] = useState(() => ({
    width: globalThis.innerWidth ?? 1024,
    height: globalThis.innerHeight ?? 768,
  }));
  useEffect(() => {
    const update = () => setSize({ width: innerWidth, height: innerHeight });
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, []);
  return size;
}

export function useColorScheme(): "dark" | "light" {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(
    () => globalThis.matchMedia?.(query).matches ?? true,
  );
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return dark ? "dark" : "light";
}
