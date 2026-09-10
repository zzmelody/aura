import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "@aura/ui/web";
import {
  Check,
  ChevronRight,
  Monitor,
  Moon,
  Radio,
  Sun,
  WandSparkles,
  Wifi,
} from "lucide-react";
import {
  Button,
  Label,
  Orb,
  Reveal,
  SectionHeading,
  useTheme,
} from "@aura/ui/components";
import { fonts, palettes, type as textType } from "@aura/ui/theme";
import { validateEndpoint } from "@aura/core";
import type { WorkspaceController } from "../useWorkspace";
import type { ThemeMode } from "@aura/core/types";

export function SettingsScreen({
  workspace,
  systemReduced,
}: {
  workspace: WorkspaceController;
  systemReduced: boolean;
}) {
  const { colors, dark } = useTheme();
  const [address, setAddress] = useState(
    workspace.state.endpoint || "http://127.0.0.1:4311",
  );
  const [connection, setConnection] = useState("");
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState(false);
  async function connect() {
    const endpoint = validateEndpoint(address);
    if (!endpoint) {
      setConnection("请输入完整服务地址，例如 http://192.168.1.8:4311");
      return;
    }
    setChecking(true);
    setConnection("");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const result = await fetch(`${endpoint}/health`, {
        signal: abort.signal,
      });
      const health = await result.json();
      if (
        !result.ok ||
        health.service !== "aura-runtime" ||
        !Array.isArray(health.modes) ||
        !health.modes.includes("dsh-demo")
      )
        throw new Error("此地址没有运行 Aura 对话服务。");
      workspace.setState((s) => ({ ...s, endpoint, provider: "dsh" }));
      setConnection("连接成功。新消息将通过官方 DSH 演示链路。");
    } catch (e) {
      setConnection(
        e instanceof Error && e.name !== "AbortError"
          ? "连接失败。请确认地址、网络与工作台服务。"
          : "连接超时，请检查工作台地址。",
      );
    } finally {
      clearTimeout(timeout);
      setChecking(false);
    }
  }
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Reveal>
        <Label>MAKE IT YOURS</Label>
        <Text style={[textType.title, { color: colors.text, marginTop: 14 }]}>
          以你喜欢的方式。
        </Text>
        <Text
          style={[
            textType.body,
            { color: colors.secondary, marginTop: 8, marginBottom: 30 },
          ]}
        >
          让工作台，成为你的空间。
        </Text>
      </Reveal>
      <SectionHeading title="外观" meta="01 / APPEARANCE" />
      <View style={styles.themes}>
        {[
          { id: "dark", title: "夜航", en: "MIDNIGHT", icon: Moon },
          { id: "light", title: "晨雾", en: "DAYBREAK", icon: Sun },
        ].map(({ id, title, en, icon: Icon }) => {
          const palette = palettes[id as "dark" | "light"];
          return (
            <Pressable
              key={id}
              accessibilityRole="radio"
              accessibilityLabel={`${title} · ${id === "dark" ? "深色" : "浅色"}主题`}
              accessibilityState={{ checked: workspace.state.theme === id }}
              onPress={() =>
                workspace.setState((s) => ({ ...s, theme: id as ThemeMode }))
              }
              style={[
                styles.themeChoice,
                {
                  backgroundColor: palette.background,
                  borderColor:
                    workspace.state.theme === id
                      ? colors.accent
                      : colors.border,
                  borderWidth: workspace.state.theme === id ? 2 : 1,
                },
              ]}
            >
              <View style={styles.miniApp}>
                <View
                  style={{
                    height: 7,
                    width: 29,
                    backgroundColor: palette.accent,
                    borderRadius: 4,
                  }}
                />
                <View
                  style={{
                    height: 30,
                    width: "75%",
                    backgroundColor: palette.surface,
                    borderRadius: 7,
                    marginTop: 14,
                    borderWidth: 1,
                    borderColor: palette.border,
                  }}
                />
                <View
                  style={{
                    height: 7,
                    width: "50%",
                    backgroundColor: palette.border,
                    borderRadius: 4,
                    marginTop: 9,
                  }}
                />
                <View
                  style={{
                    height: 7,
                    width: "68%",
                    backgroundColor: palette.border,
                    borderRadius: 4,
                    marginTop: 6,
                  }}
                />
              </View>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 7 }}
              >
                <Icon color={palette.accent} size={16} />
                <Text
                  style={{
                    color: palette.text,
                    fontFamily: fonts.medium,
                    fontSize: 14,
                  }}
                >
                  {title}
                </Text>
                {workspace.state.theme === id ? (
                  <Check
                    size={16}
                    color={palette.accent}
                    style={{ marginLeft: "auto" }}
                  />
                ) : null}
              </View>
              <Text
                style={[
                  textType.label,
                  { color: palette.muted, fontSize: 8, marginTop: 7 },
                ]}
              >
                {en}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.row, { borderColor: colors.border }]}>
        <View style={styles.rowLabel}>
          <Monitor size={18} color={colors.secondary} />
          <Text style={[textType.body, { color: colors.text }]}>跟随系统</Text>
        </View>
        <Switch
          accessibilityLabel="跟随系统主题"
          value={workspace.state.theme === "system"}
          onValueChange={(value) =>
            workspace.setState((s) => ({
              ...s,
              theme: value ? "system" : dark ? "dark" : "light",
            }))
          }
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor="#FFFFFF"
        />
      </View>
      <View style={[styles.row, { borderColor: colors.border }]}>
        <View style={{ gap: 4, flex: 1 }}>
          <View style={styles.rowLabel}>
            <WandSparkles size={18} color={colors.secondary} />
            <Text style={[textType.body, { color: colors.text }]}>
              减少动态效果
            </Text>
          </View>
          <Text
            style={[textType.small, { color: colors.muted, paddingLeft: 30 }]}
          >
            {systemReduced
              ? "已遵循系统的减少动态效果设置"
              : "关闭轨道旋转与入场过渡"}
          </Text>
        </View>
        <Switch
          accessibilityLabel="减少动态效果"
          value={workspace.state.reduceMotion || systemReduced}
          disabled={systemReduced}
          onValueChange={(value) =>
            workspace.setState((s) => ({ ...s, reduceMotion: value }))
          }
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor="#FFFFFF"
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查看主题设计规范"
        onPress={() => setPreview((v) => !v)}
        style={[styles.row, { borderColor: colors.border }]}
      >
        <Text style={[textType.body, { color: colors.text }]}>主题实验室</Text>
        <ChevronRight
          size={18}
          color={colors.muted}
          style={{ transform: `rotate(${preview ? "90deg" : "0deg"})` }}
        />
      </Pressable>
      {preview ? (
        <Reveal
          style={[
            styles.lab,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Label>CHROMATIC / TYPOGRAPHIC / KINETIC</Label>
          <Text
            style={{
              fontFamily: fonts.display,
              color: colors.text,
              fontSize: 40,
              letterSpacing: -2,
              marginVertical: 16,
            }}
          >
            Aa. aura
          </Text>
          <Text style={[textType.small, { color: colors.secondary }]}>
            Manrope · 界面与标题{"\n"}IBM Plex Mono · 数字与技术标签{"\n"}中文 ·
            设备原生中文字体
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 20 }}>
            {["background", "surface", "soft", "accent", "primary"].map(
              (key) => (
                <View key={key} style={{ flex: 1, gap: 6 }}>
                  <View
                    style={{
                      height: 36,
                      borderRadius: 9,
                      backgroundColor: colors[key as keyof typeof colors],
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  />
                  <Text
                    style={{
                      fontFamily: fonts.mono,
                      color: colors.muted,
                      fontSize: 8,
                    }}
                  >
                    {colors[key as keyof typeof colors]}
                  </Text>
                </View>
              ),
            )}
          </View>
          <Orb compact />
          <Label>PRESS 110ms · REVEAL 420ms · ORBIT 24s</Label>
        </Reveal>
      ) : null}
      <View style={{ marginTop: 34 }}>
        <SectionHeading title="对话服务" meta="02 / CONNECTION" />
        <View
          style={[
            styles.service,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Radio size={20} color={colors.accent} />
            <Text
              style={{
                color: colors.text,
                fontFamily: fonts.medium,
                fontSize: 14,
              }}
            >
              {workspace.state.provider === "offline"
                ? "本地演示"
                : workspace.state.provider === "codex"
                  ? "DSH · Codex 订阅"
                  : "DSH 演示服务"}
            </Text>
            <View
              style={{
                marginLeft: "auto",
                width: 6,
                height: 6,
                backgroundColor: colors.success,
                borderRadius: 3,
              }}
            />
          </View>
          <Text
            style={[
              textType.small,
              { color: colors.secondary, marginTop: 12, marginBottom: 18 },
            ]}
          >
            本地模式无需联网。连接工作台后可以使用 DSH 演示；登录
            Codex 后，真实回复仍由 DSH 的模型适配器与会话链路处理。
          </Text>
          {workspace.state.provider !== "offline" ? (
            <Button
              secondary
              compact
              disabled={workspace.busy}
              icon={Radio}
              onPress={() => {
                workspace.setState((s) => ({ ...s, provider: "offline" }));
                setConnection("已切回本地演示。");
              }}
            >
              使用本地演示
            </Button>
          ) : null}
          <Text
            style={[
              textType.small,
              { color: colors.muted, marginTop: 18, marginBottom: 8 },
            ]}
          >
            工作台服务地址
          </Text>
          <TextInput
            accessibilityLabel="工作台服务地址"
            value={address}
            onChangeText={setAddress}
            placeholder="http://192.168.1.8:4311"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[
              styles.address,
              {
                color: colors.text,
                backgroundColor: colors.input,
                borderColor: colors.border,
              },
            ]}
          />
          <Text
            style={[
              textType.small,
              { color: colors.muted, marginTop: 8, marginBottom: 16 },
            ]}
          >
            手机连接时请填写电脑的局域网 IP。
          </Text>
          <Button
            secondary
            compact
            icon={Wifi}
            disabled={checking || workspace.busy}
            onPress={() => void connect()}
          >
            {checking ? "正在连接…" : "测试并连接"}
          </Button>
          {connection ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[textType.small, { color: colors.accent, marginTop: 12 }]}
            >
              {connection}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ alignItems: "center", marginTop: 32, gap: 6 }}>
        <Label>AURA / VERSION 0.1.0</Label>
        <Text style={[textType.small, { color: colors.muted }]}>
          专注于日常，也给灵感留白。
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    padding: 24,
    paddingBottom: 36,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  themes: { flexDirection: "row", gap: 12 },
  themeChoice: { flex: 1, borderRadius: 18, padding: 17 },
  miniApp: { marginBottom: 22, paddingHorizontal: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 66,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    gap: 12,
  },
  rowLabel: { flexDirection: "row", gap: 12, alignItems: "center" },
  lab: { padding: 18, marginTop: 16, borderWidth: 1, borderRadius: 18 },
  service: { padding: 20, borderRadius: 18, borderWidth: 1 },
  address: {
    fontFamily: fonts.mono,
    fontSize: 13,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    minHeight: 48,
  },
});
