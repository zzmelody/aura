import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ArrowUp, Check, Copy, RotateCcw, Square } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import {
  AuraMark,
  IconButton,
  Label,
  Orb,
  Reveal,
  useTheme,
} from "@aura/ui/components";
import { fonts, type as textType } from "@aura/ui/theme";
import type { WorkspaceController } from "../useWorkspace";
import type { Message } from "@aura/core/types";

function MessageView({
  message,
  retry,
  workspaceProvider,
}: {
  message: Message;
  retry?: () => void;
  workspaceProvider: WorkspaceController["state"]["provider"];
}) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 1800);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  const user = message.role === "user";
  return (
    <Reveal
      style={{ alignItems: user ? "flex-end" : "flex-start", marginBottom: 28 }}
    >
      {!user ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            marginBottom: 10,
          }}
        >
          <AuraMark size={23} />
          <Text
            style={{
              color: colors.text,
              fontFamily: fonts.display,
              fontSize: 13,
            }}
          >
            Aura
          </Text>
          <Label color={colors.muted}>
            {workspaceProvider === "codex" ? "CODEX" : "DEMO"}
          </Label>
        </View>
      ) : null}
      <View
        style={[
          styles.message,
          {
            backgroundColor: user ? colors.user : colors.surface,
            borderColor: user ? colors.user : colors.border,
            borderTopRightRadius: user ? 5 : 18,
            borderTopLeftRadius: user ? 18 : 5,
            maxWidth: user ? "90%" : "100%",
          },
        ]}
      >
        {message.text ? (
          <Text
            selectable
            style={[
              textType.body,
              {
                color: message.status === "error" ? colors.danger : colors.text,
              },
            ]}
          >
            {message.text}
          </Text>
        ) : message.status === "streaming" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={[textType.small, { color: colors.muted }]}>
              正在准备回复
            </Text>
          </View>
        ) : null}
        {message.status === "streaming" && message.text ? (
          <View
            style={{
              width: 6,
              height: 14,
              backgroundColor: colors.accent,
              marginTop: 5,
              borderRadius: 1,
            }}
          />
        ) : null}
        {message.status === "stopped" ? (
          <Text
            style={[textType.small, { color: colors.muted, marginTop: 10 }]}
          >
            回复已停止
          </Text>
        ) : null}
      </View>
      {!user && message.status !== "streaming" ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 2,
          }}
        >
          <IconButton
            label={copied ? "已复制" : "复制回复"}
            icon={copied ? Check : Copy}
            onPress={() => {
              void Clipboard.setStringAsync(message.text)
                .then(() => {
                  setCopied(true);
                  setCopyError(false);
                })
                .catch(() => setCopyError(true));
            }}
          />
          {message.status === "error" && retry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重试上一条消息"
              onPress={retry}
              style={styles.retry}
            >
              <RotateCcw size={14} color={colors.accent} />
              <Text style={[textType.small, { color: colors.accent }]}>
                重试
              </Text>
            </Pressable>
          ) : null}
          {copied || copyError ? (
            <Text style={[textType.small, { color: colors.muted }]}>
              {copied ? "已复制" : "请长按文字手动复制"}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Reveal>
  );
}

export function ChatScreen({ workspace }: { workspace: WorkspaceController }) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const nearBottom = useRef(true);
  const input = useRef<TextInput>(null);
  const messages = workspace.active?.messages ?? [];
  useEffect(() => {
    setDraft("");
    nearBottom.current = true;
  }, [workspace.active?.id]);
  function submit() {
    if (draft.trim() && !workspace.busy) {
      void workspace.send(draft);
      setDraft("");
      nearBottom.current = true;
    }
  }
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        maxWidth: 860,
        alignSelf: "center",
      }}
    >
      <View style={[styles.chatTitle, { borderColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.medium,
              fontSize: 14,
              color: colors.text,
            }}
          >
            {workspace.active?.title ?? "新的对话"}
          </Text>
          <Text style={[textType.small, { color: colors.muted, marginTop: 4 }]}>
            {workspace.state.provider === "offline"
              ? "本地演示 · 对话只留在你的设备"
              : workspace.state.provider === "codex"
                ? "Codex 订阅 · 由 DSH 管理会话与模型"
                : "DSH 演示 · 通过工作台服务连接"}
          </Text>
        </View>
        <View style={[styles.pill, { backgroundColor: colors.soft }]}>
          <View
            style={{
              backgroundColor: colors.success,
              width: 5,
              height: 5,
              borderRadius: 3,
            }}
          />
          <Text
            style={{
              fontFamily: fonts.mono,
              fontSize: 9,
              color: colors.accent,
              letterSpacing: 1,
            }}
          >
            {workspace.busy ? "ACTIVE" : "READY"}
          </Text>
        </View>
      </View>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.transcript}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          if (nearBottom.current)
            scroll.current?.scrollToEnd({ animated: false });
        }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } =
            e.nativeEvent;
          nearBottom.current =
            contentSize.height - layoutMeasurement.height - contentOffset.y <
            100;
        }}
        scrollEventThrottle={100}
      >
        {!messages.length ? (
          <Reveal>
            <View style={{ marginTop: 15 }}>
              <Orb compact />
            </View>
            <Text
              style={[
                textType.title,
                { color: colors.text, textAlign: "center", marginTop: 14 },
              ]}
            >
              今天，想从哪里开始？
            </Text>
            <Text
              style={[
                textType.body,
                {
                  color: colors.secondary,
                  textAlign: "center",
                  marginTop: 12,
                  marginBottom: 26,
                },
              ]}
            >
              一个问题，一闪而过的灵感，{"\n"}或者只是打个招呼。
            </Text>
            <View style={{ gap: 10, alignItems: "center" }}>
              {[
                "你好，Aura",
                "帮我安排今天的计划",
                "我有一个新想法，帮我梳理一下",
              ].map((prompt) => (
                <Pressable
                  key={prompt}
                  accessibilityRole="button"
                  onPress={() => {
                    void workspace.send(prompt);
                  }}
                  style={({ pressed }) => [
                    styles.suggestion,
                    {
                      borderColor: colors.border,
                      backgroundColor: pressed ? colors.soft : colors.surface,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: colors.secondary,
                      fontFamily: fonts.body,
                      fontSize: 13,
                    }}
                  >
                    {prompt}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Reveal>
        ) : (
          messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              workspaceProvider={workspace.state.provider}
              retry={
                message.id === messages.at(-1)?.id ? workspace.retry : undefined
              }
            />
          ))
        )}
      </ScrollView>
      <View
        style={[
          styles.composerArea,
          { borderColor: colors.border, backgroundColor: colors.background },
        ]}
      >
        <View
          style={[
            styles.composer,
            {
              backgroundColor: colors.input,
              borderColor: focused ? colors.accent : colors.border,
            },
          ]}
        >
          <TextInput
            ref={input}
            accessibilityLabel="消息输入框"
            placeholder="把你的想法，放在这里…"
            placeholderTextColor={colors.muted}
            multiline
            maxLength={4000}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={[
              styles.input,
              { color: colors.text },
              Platform.OS === "web" ? { outlineWidth: 0 } : null,
            ]}
            onKeyPress={(e) => {
              if (Platform.OS === "web") {
                const event = e as unknown as {
                  nativeEvent: {
                    key: string;
                    shiftKey?: boolean;
                    isComposing?: boolean;
                  };
                  preventDefault: () => void;
                };
                if (
                  event.nativeEvent.key === "Enter" &&
                  !event.nativeEvent.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  submit();
                }
              }
            }}
          />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingLeft: 5,
            }}
          >
            <Text
              style={[textType.small, { color: colors.muted, fontSize: 10 }]}
            >
              {draft.length > 3600
                ? `${draft.length} / 4000`
                : workspace.state.provider === "offline"
                  ? "AURA · LOCAL DEMO"
                  : workspace.state.provider === "codex"
                    ? "AURA · DSH / CODEX"
                    : "AURA · DSH DEMO"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={workspace.busy ? "停止生成" : "发送消息"}
              accessibilityState={{
                disabled: !workspace.busy && !draft.trim(),
              }}
              disabled={!workspace.busy && !draft.trim()}
              onPress={workspace.busy ? workspace.stop : submit}
              style={({ pressed }) => [
                styles.send,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed
                    ? 0.7
                    : !workspace.busy && !draft.trim()
                      ? 0.4
                      : 1,
                },
              ]}
            >
              {workspace.busy ? (
                <Square
                  size={16}
                  fill={colors.primaryText}
                  color={colors.primaryText}
                />
              ) : (
                <ArrowUp
                  size={22}
                  color={colors.primaryText}
                  strokeWidth={1.8}
                />
              )}
            </Pressable>
          </View>
        </View>
        <Text
          style={[
            textType.small,
            {
              color: colors.muted,
              textAlign: "center",
              fontSize: 10,
              marginTop: 8,
            },
          ]}
        >
          {workspace.state.provider === "codex"
            ? "回复由你的 Codex 订阅生成，并通过 DSH 处理。"
            : "演示内容由规则生成，未调用真实 AI 模型。"}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.live}>
          {workspace.busy
            ? "正在生成回复"
            : messages.at(-1)?.role === "assistant"
              ? "回复结束"
              : ""}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chatTitle: {
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  transcript: { padding: 24, paddingBottom: 6, flexGrow: 1 },
  message: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 15,
  },
  suggestion: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
  },
  composerArea: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  composer: { borderWidth: 1, borderRadius: 20, padding: 10 },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 24,
    minHeight: 45,
    maxHeight: 116,
    paddingHorizontal: 7,
    paddingTop: 6,
    paddingBottom: 10,
    textAlignVertical: "top",
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  live: { height: 0, width: 0, overflow: "hidden" },
});
