import React, { useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Check, Copy, ExternalLink, X } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "@aura/ui/components";
import { fonts, type as textType } from "@aura/ui/theme";
import type { CodexAuthController } from "./useCodexAuth";

export function CodexLoginButton({
  auth,
  compact,
}: {
  auth: CodexAuthController;
  compact: boolean;
}) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const connected = auth.status.state === "authenticated";
  const pending = auth.status.state === "pending";
  const pendingStatus = auth.status.state === "pending" ? auth.status : null;
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!pendingStatus?.prompt) setManualInput("");
  }, [pendingStatus?.prompt]);

  function open() {
    setVisible(true);
    if (!connected && !pending && !auth.loading) void auth.start();
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={connected ? "Codex 已连接" : "登录 Codex"}
        onPress={open}
        style={({ pressed }) => [
          styles.trigger,
          {
            backgroundColor: connected ? colors.soft : "transparent",
            borderColor: connected ? colors.accent : colors.border,
            opacity: pressed ? 0.65 : 1,
          },
        ]}
      >
        <View
          style={[
            styles.dot,
            {
              backgroundColor: connected
                ? colors.success
                : pending
                  ? colors.accent
                  : colors.muted,
            },
          ]}
        />
        <Text
          style={[
            styles.triggerText,
            { color: connected ? colors.text : colors.secondary },
          ]}
        >
          {compact
            ? connected
              ? "已连接"
              : pending
                ? "登录中"
                : "Codex"
            : connected
              ? "Codex 已连接"
              : pending
                ? "登录中"
                : "登录 Codex"}
        </Text>
      </Pressable>
      <Modal
        animationType="fade"
        transparent
        visible={visible}
        onRequestClose={() => setVisible(false)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭 Codex 登录窗口"
          style={styles.backdrop}
          onPress={() => setVisible(false)}
        >
          <Pressable
            accessibilityRole="none"
            onPress={(event) => event.stopPropagation()}
            style={[
              styles.panel,
              { backgroundColor: colors.elevated, borderColor: colors.border },
            ]}
          >
            <ScrollView
              contentContainerStyle={styles.panelContent}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.panelTop}>
                <View>
                  <Text style={[styles.eyebrow, { color: colors.accent }]}>
                    OPENAI / CODEX
                  </Text>
                  <Text style={[styles.title, { color: colors.text }]}>
                    连接你的订阅
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭"
                  onPress={() => setVisible(false)}
                  style={styles.close}
                >
                  <X size={20} color={colors.secondary} />
                </Pressable>
              </View>

              {connected ? (
                <View
                  style={[
                    styles.statusCard,
                    {
                      backgroundColor: colors.soft,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Check size={20} color={colors.success} />
                  <View style={{ flex: 1 }}>
                    <Text style={[textType.body, { color: colors.text }]}>
                      已通过 ChatGPT 订阅连接
                    </Text>
                    <Text
                      style={[
                        textType.small,
                        { color: colors.muted, marginTop: 3 },
                      ]}
                    >
                      新对话将直接使用 {auth.status.model}
                    </Text>
                  </View>
                </View>
              ) : (
                <>
                  <Text
                    style={[
                      textType.body,
                      { color: colors.secondary, marginTop: 18 },
                    ]}
                  >
                    Aura 会通过 DSH 的授权流程登录，再由 DSH 的 pi-ai 适配器调用
                    Codex。不会读取 Codex 应用缓存，也不需要 API Key。
                  </Text>
                  {pendingStatus?.userCode ? (
                    <View
                      style={[
                        styles.codeCard,
                        {
                          backgroundColor: colors.background,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text style={[styles.eyebrow, { color: colors.muted }]}>
                        DEVICE CODE
                      </Text>
                      <Text
                        selectable
                        style={[styles.code, { color: colors.text }]}
                      >
                        {pendingStatus.userCode}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          void Clipboard.setStringAsync(
                            pendingStatus.userCode ?? "",
                          );
                          setCopied(true);
                        }}
                        style={styles.copy}
                      >
                        {copied ? (
                          <Check size={15} color={colors.success} />
                        ) : (
                          <Copy size={15} color={colors.accent} />
                        )}
                        <Text
                          style={[textType.small, { color: colors.accent }]}
                        >
                          {copied ? "已复制" : "复制验证码"}
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[
                      textType.small,
                      {
                        color:
                          auth.status.state === "error"
                            ? colors.danger
                            : colors.muted,
                        marginTop: 16,
                      },
                    ]}
                  >
                    {pending
                      ? pendingStatus?.userCode
                        ? "浏览器已打开。输入上方验证码后，这里会自动完成连接。"
                        : "浏览器已打开，完成 OpenAI 登录后会自动返回。"
                      : auth.status.state === "error"
                        ? auth.status.message
                        : "点击下方按钮开始登录。"}
                  </Text>
                  {pendingStatus?.prompt ? (
                    <View style={styles.manualArea}>
                      <Text
                        style={[textType.small, { color: colors.secondary }]}
                      >
                        如果浏览器没有自动返回，请复制浏览器最后停留的完整地址并粘贴到这里。
                      </Text>
                      <TextInput
                        accessibilityLabel="OpenAI 授权结果"
                        autoCapitalize="none"
                        autoCorrect={false}
                        editable={!auth.loading}
                        onChangeText={setManualInput}
                        onSubmitEditing={() => {
                          if (manualInput.trim()) void auth.submit(manualInput);
                        }}
                        placeholder={
                          pendingStatus.prompt.placeholder ??
                          "粘贴回调地址或授权码"
                        }
                        placeholderTextColor={colors.muted}
                        secureTextEntry={
                          pendingStatus.prompt.kind === "secret"
                        }
                        selectionColor={colors.accent}
                        style={[
                          styles.manualInput,
                          {
                            backgroundColor: colors.background,
                            borderColor: colors.border,
                            color: colors.text,
                          },
                        ]}
                        value={manualInput}
                      />
                      <Pressable
                        accessibilityRole="button"
                        disabled={!manualInput.trim() || auth.loading}
                        onPress={() => void auth.submit(manualInput)}
                        style={({ pressed }) => [
                          styles.submit,
                          {
                            borderColor: colors.accent,
                            opacity:
                              !manualInput.trim() || auth.loading
                                ? 0.45
                                : pressed
                                  ? 0.7
                                  : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[textType.small, { color: colors.accent }]}
                        >
                          提交授权结果
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {pending ? (
                    <View style={styles.pendingActions}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={auth.loading}
                        onPress={() => void auth.refresh()}
                        style={({ pressed }) => [
                          styles.secondary,
                          {
                            borderColor: colors.border,
                            opacity: pressed ? 0.7 : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[textType.small, { color: colors.secondary }]}
                        >
                          检查登录状态
                        </Text>
                      </Pressable>
                      {pendingStatus?.method === "browser" ? (
                        <Pressable
                          accessibilityRole="button"
                          disabled={auth.loading}
                          onPress={() => void auth.restart("device_code")}
                          style={({ pressed }) => [
                            styles.secondary,
                            {
                              borderColor: colors.border,
                              opacity: pressed ? 0.7 : 1,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              textType.small,
                              { color: colors.secondary },
                            ]}
                          >
                            改用设备码
                          </Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        accessibilityRole="button"
                        disabled={auth.loading}
                        onPress={() => void auth.cancel()}
                        style={({ pressed }) => [
                          styles.secondary,
                          {
                            borderColor: colors.border,
                            opacity: pressed ? 0.7 : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[textType.small, { color: colors.secondary }]}
                        >
                          取消登录
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {!pending ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={auth.loading}
                      onPress={() => void auth.start()}
                      style={({ pressed }) => [
                        styles.primary,
                        {
                          backgroundColor: colors.primary,
                          opacity: auth.loading ? 0.5 : pressed ? 0.75 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.primaryText,
                          { color: colors.primaryText },
                        ]}
                      >
                        {auth.loading ? "正在连接…" : "使用 ChatGPT 账号登录"}
                      </Text>
                      <ExternalLink size={17} color={colors.primaryText} />
                    </Pressable>
                  ) : null}
                </>
              )}
              <Text style={[styles.footer, { color: colors.muted }]}>
                {Platform.OS === "web"
                  ? "登录页会在新窗口打开"
                  : "登录页会在系统浏览器打开"}{" "}
                · 凭据由 Aura 后端的 DSH 管理
              </Text>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    minHeight: 38,
    borderRadius: 13,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  triggerText: { fontFamily: fonts.medium, fontSize: 12 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(6, 4, 10, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  panel: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "92%",
    borderWidth: 1,
    borderRadius: 24,
  },
  panelContent: { padding: 24 },
  panelTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  eyebrow: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.5 },
  title: {
    fontFamily: fonts.display,
    fontSize: 25,
    marginTop: 8,
    letterSpacing: -0.5,
  },
  close: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  statusCard: {
    marginTop: 22,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  codeCard: {
    marginTop: 20,
    padding: 18,
    borderWidth: 1,
    borderRadius: 16,
    alignItems: "center",
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 28,
    letterSpacing: 5,
    marginVertical: 12,
  },
  copy: {
    minHeight: 40,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  manualArea: { marginTop: 16, gap: 10 },
  manualInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  submit: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  pendingActions: {
    marginTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  secondary: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  primary: {
    minHeight: 50,
    borderRadius: 15,
    marginTop: 20,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  primaryText: { fontFamily: fonts.medium, fontSize: 14 },
  footer: {
    fontFamily: fonts.body,
    fontSize: 10,
    lineHeight: 16,
    marginTop: 18,
    textAlign: "center",
  },
});
