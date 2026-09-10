import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from "@aura/ui/web";
import {
  Clock3,
  Grid2X2,
  GitBranch,
  MessageCircle,
  Moon,
  Plus,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import { AuraMark, IconButton, Label, ThemeContext } from "@aura/ui/components";
import { fonts, palettes } from "@aura/ui/theme";
import { useWorkspace } from "./useWorkspace";
import { useCodexAuth } from "./useCodexAuth";
import { CodexLoginButton } from "./CodexLoginButton";
import { HomeScreen, HistoryScreen } from "./screens/Home";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";
import { FlowsScreen } from "./screens/Flows";
import type { Tab } from "./types";

const tabs = [
  { id: "home", label: "空间", icon: Grid2X2 },
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "flows", label: "流程", icon: GitBranch },
  { id: "history", label: "记录", icon: Clock3 },
  { id: "settings", label: "设置", icon: SlidersHorizontal },
] as const;

export default function App() {
  const workspace = useWorkspace();
  const codexAuth = useCodexAuth(workspace);
  const [tab, setTab] = useState<Tab>("home");
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
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, []);
  useEffect(() => {
    document.documentElement.style.backgroundColor = colors.background;
    document.body.style.backgroundColor = colors.background;
  }, [colors.background]);
  useEffect(() => {
    document.title = "Aura · 留一点空间，给下一个想法";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
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

  if (!workspace.ready)
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
    <ThemeContext.Provider value={{ colors, dark, reduced }}>
      <View
        className="aura-root"
        style={{ backgroundColor: colors.background }}
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
                          : tab === "flows"
                            ? "AGENT WORKFLOWS"
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
              <View style={{ flex: 1, minHeight: 0 }}>
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
                {tab === "flows" ? (
                  <FlowsScreen endpoint={codexAuth.endpoint} />
                ) : null}
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
              </View>
              {!wide ? nav : null}
            </View>
        </View>
      </View>
    </ThemeContext.Provider>
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
