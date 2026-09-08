import React, { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { Manrope_400Regular } from "@expo-google-fonts/manrope/400Regular";
import { Manrope_500Medium } from "@expo-google-fonts/manrope/500Medium";
import { Manrope_600SemiBold } from "@expo-google-fonts/manrope/600SemiBold";
import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular";
import * as SystemUI from "expo-system-ui";
import {
  Clock3,
  Grid2X2,
  MessageCircle,
  Moon,
  Plus,
  SlidersHorizontal,
  Sun,
} from "lucide-react-native";
import { AuraMark, IconButton, Label, ThemeContext } from "@aura/ui/components";
import { fonts, palettes } from "@aura/ui/theme";
import { useWorkspace } from "./useWorkspace";
import { useCodexAuth } from "./useCodexAuth";
import { CodexLoginButton } from "./CodexLoginButton";
import { HomeScreen, HistoryScreen } from "./screens/Home";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";
import type { Tab } from "./types";

const tabs = [
  { id: "home", label: "空间", icon: Grid2X2 },
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "history", label: "记录", icon: Clock3 },
  { id: "settings", label: "设置", icon: SlidersHorizontal },
] as const;

export default function App() {
  const workspace = useWorkspace();
  const codexAuth = useCodexAuth(workspace);
  const [tab, setTab] = useState<Tab>("home");
  const [keyboard, setKeyboard] = useState(false);
  const [systemReduced, setSystemReduced] = useState(false);
  const systemTheme = useColorScheme();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const dark =
    workspace.state.theme === "system"
      ? systemTheme !== "light"
      : workspace.state.theme === "dark";
  const colors = dark ? palettes.dark : palettes.light;
  const reduced = systemReduced || workspace.state.reduceMotion;
  const [loaded, fontError] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    IBMPlexMono_400Regular,
  });
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setSystemReduced(value);
    });
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setSystemReduced,
    );
    const show = Keyboard.addListener("keyboardDidShow", () =>
      setKeyboard(true),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () =>
      setKeyboard(false),
    );
    return () => {
      mounted = false;
      sub.remove();
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);
  useEffect(() => {
    if (Platform.OS === "web") {
      document.title = "Aura · 留一点空间，给下一个想法";
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    }
  }, [dark]);
  const toggleTheme = () =>
    workspace.setState((s) => ({ ...s, theme: dark ? "light" : "dark" }));
  const start = (prompt?: string) => {
    if (workspace.busy) {
      setTab("chat");
      return;
    }
    workspace.newChat();
    setTab("chat");
    if (prompt) pendingPrompt(prompt);
  };
  const [queuedPrompt, pendingPrompt] = useState("");
  useEffect(() => {
    if (queuedPrompt && !workspace.active) {
      void workspace.send(queuedPrompt);
      pendingPrompt("");
    }
  }, [queuedPrompt, workspace.active]);

  if ((!loaded && !fontError) || !workspace.ready)
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.secondary, marginTop: 16 }}>
          正在打开你的空间
        </Text>
      </View>
    );
  const nav = (
    <View
      style={[
        wide ? styles.sideNav : styles.bottomNav,
        { borderColor: colors.border, backgroundColor: colors.background },
      ]}
    >
      {tabs.map(({ id, label, icon: Icon }) => (
        <Pressable
          key={id}
          accessibilityRole="tab"
          accessibilityLabel={label}
          accessibilityState={{ selected: tab === id }}
          onPress={() => setTab(id)}
          style={({ pressed }) => [
            wide ? styles.sideNavItem : styles.navItem,
            {
              backgroundColor: wide && tab === id ? colors.soft : "transparent",
              opacity: pressed ? 0.6 : 1,
            },
          ]}
        >
          <Icon
            size={21}
            strokeWidth={tab === id ? 2 : 1.6}
            color={tab === id ? colors.accent : colors.muted}
          />
          <Text
            style={{
              color: tab === id ? colors.accent : colors.muted,
              fontFamily: fonts.medium,
              fontSize: wide ? 14 : 10,
            }}
          >
            {label}
          </Text>
          {wide && tab === id ? (
            <View
              style={{
                marginLeft: "auto",
                width: 5,
                height: 5,
                borderRadius: 3,
                backgroundColor: colors.accent,
              }}
            />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={{ colors, dark, reduced }}>
        <StatusBar style={dark ? "light" : "dark"} />
        <SafeAreaView
          style={{ flex: 1, backgroundColor: colors.background }}
          edges={["top", "bottom"]}
        >
          <View style={styles.shell}>
            {wide ? (
              <View style={[styles.sidebar, { borderColor: colors.border }]}>
                <View style={styles.brand}>
                  <AuraMark />
                  <Text style={[styles.wordmark, { color: colors.text }]}>
                    aura
                  </Text>
                  <Text style={{ color: colors.accent, fontSize: 22 }}>✦</Text>
                </View>
                <View style={{ marginTop: 8, paddingLeft: 6 }}>
                  <Label>YOUR PERSONAL SPACE</Label>
                </View>
                <View style={{ marginTop: 50 }}>{nav}</View>
                <View style={{ marginTop: "auto", gap: 12, padding: 8 }}>
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: colors.success },
                    ]}
                  />
                  <Text
                    style={{
                      fontFamily: fonts.body,
                      color: colors.secondary,
                      fontSize: 12,
                      lineHeight: 22,
                    }}
                  >
                    留一点空间，{"\n"}给下一个想法。
                  </Text>
                  <Label>AURA / 0.1.0</Label>
                </View>
              </View>
            ) : null}
            <View style={styles.main}>
              <View style={[styles.header, { borderColor: colors.border }]}>
                <View style={styles.brand}>
                  {wide ? (
                    <Label>
                      {tab === "home"
                        ? "WORKSPACE"
                        : tab === "chat"
                          ? "CONVERSATION"
                          : tab === "history"
                            ? "YOUR ARCHIVE"
                            : "PREFERENCES"}
                    </Label>
                  ) : (
                    <>
                      <AuraMark size={27} />
                      <Text style={[styles.wordmark, { color: colors.text }]}>
                        aura
                      </Text>
                    </>
                  )}
                </View>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                >
                  <CodexLoginButton auth={codexAuth} compact={!wide} />
                  <IconButton
                    icon={dark ? Sun : Moon}
                    label={dark ? "切换到浅色主题" : "切换到深色主题"}
                    onPress={toggleTheme}
                  />
                  {tab === "chat" ? (
                    <IconButton
                      icon={Plus}
                      label="新建对话"
                      onPress={() => start()}
                      disabled={workspace.busy}
                    />
                  ) : (
                    <View
                      style={[
                        styles.avatar,
                        {
                          backgroundColor: colors.soft,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontFamily: fonts.mono,
                          fontSize: 12,
                          color: colors.accent,
                        }}
                      >
                        YOU
                      </Text>
                    </View>
                  )}
                </View>
              </View>
              {workspace.saveError ? (
                <Text
                  accessibilityRole="alert"
                  style={{
                    paddingHorizontal: 24,
                    color: colors.danger,
                    fontSize: 12,
                  }}
                >
                  {workspace.saveError}
                </Text>
              ) : null}
              <KeyboardAvoidingView
                style={{ flex: 1, minHeight: 0 }}
                behavior={Platform.OS === "ios" ? "padding" : undefined}
              >
                {tab === "home" ? (
                  <HomeScreen
                    workspace={workspace}
                    start={start}
                    open={(id) => {
                      workspace.openChat(id);
                      setTab("chat");
                    }}
                  />
                ) : null}
                {tab === "chat" ? <ChatScreen workspace={workspace} /> : null}
                {tab === "history" ? (
                  <HistoryScreen
                    workspace={workspace}
                    open={(id) => {
                      workspace.openChat(id);
                      setTab("chat");
                    }}
                    start={() => start()}
                  />
                ) : null}
                {tab === "settings" ? (
                  <SettingsScreen
                    workspace={workspace}
                    systemReduced={systemReduced}
                  />
                ) : null}
              </KeyboardAvoidingView>
              {!wide && !keyboard ? nav : null}
            </View>
          </View>
        </SafeAreaView>
      </ThemeContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, justifyContent: "center", alignItems: "center" },
  shell: {
    flex: 1,
    flexDirection: "row",
    width: "100%",
    maxWidth: 1200,
    alignSelf: "center",
  },
  sidebar: { width: 230, padding: 28, borderRightWidth: 1 },
  main: { flex: 1, minWidth: 0 },
  header: {
    height: 72,
    paddingHorizontal: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 7 },
  wordmark: { fontFamily: fonts.display, fontSize: 28, letterSpacing: -1.5 },
  avatar: {
    width: 37,
    height: 37,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    marginLeft: 8,
  },
  bottomNav: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingBottom: 6,
  },
  navItem: {
    flex: 1,
    minHeight: 51,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  sideNav: { gap: 10 },
  sideNavItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
});
