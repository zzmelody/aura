import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "@aura/ui/web";
import { useTheme } from "@aura/ui/components";
import { fonts } from "@aura/ui/theme";
import { readModelServices } from "./modelServices";

/**
 * Header status for gateway providers, in place of the Codex login button.
 * Only the redacted "key saved" flag is read; pressing opens settings.
 */
export function ModelServiceBadge({
  endpoint,
  provider,
  compact,
  onOpen,
}: {
  endpoint: string;
  provider: "lumina" | "custom";
  compact: boolean;
  onOpen(): void;
}) {
  const { colors } = useTheme();
  const [ready, setReady] = useState<boolean>();
  useEffect(() => {
    const abort = new AbortController();
    setReady(undefined);
    readModelServices(endpoint, abort.signal)
      .then((state) => {
        if (abort.signal.aborted) return;
        setReady(
          provider === "lumina"
            ? state.lumina.hasKey
            : Boolean(state.customModel?.hasKey),
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) setReady(false);
      });
    return () => abort.abort();
  }, [endpoint, provider]);
  const name = provider === "lumina" ? "Lumina" : "自定义 API";
  const status =
    ready === undefined
      ? `${name} 检查中`
      : ready
        ? `${name} 已配置`
        : `${name} 未配置`;
  const label = compact || ready ? name : status;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${status}，打开模型设置`}
      title={`${status}，打开模型设置`}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.trigger,
        {
          backgroundColor: pressed ? colors.soft : "transparent",
          opacity: pressed ? 0.65 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.dot,
          {
            backgroundColor: ready
              ? colors.success
              : ready === false
                ? colors.danger
                : colors.muted,
          },
        ]}
      />
      <Text
        style={[styles.text, { color: ready ? colors.text : colors.secondary }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    minHeight: 32,
    borderRadius: 6,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontFamily: fonts.medium, fontSize: 12 },
});
