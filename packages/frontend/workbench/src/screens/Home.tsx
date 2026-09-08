import React, { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import {
  ArrowUpRight,
  ChevronRight,
  Clock3,
  Lightbulb,
  MessageCircle,
  Plus,
  Sun,
  Trash2,
} from "lucide-react-native";
import {
  AuraMark,
  Button,
  IconButton,
  Label,
  Orb,
  Reveal,
  SectionHeading,
  useTheme,
} from "@aura/ui/components";
import { fonts, type as textType } from "@aura/ui/theme";
import type { WorkspaceController } from "../useWorkspace";
import type { Session } from "@aura/core/types";

export function SessionRow({
  session,
  onPress,
}: {
  session: Session;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开会话：${session.title}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.session,
        { borderBottomColor: colors.border, opacity: pressed ? 0.6 : 1 },
      ]}
    >
      <View style={[styles.sessionIcon, { backgroundColor: colors.soft }]}>
        <MessageCircle size={18} color={colors.accent} strokeWidth={1.5} />
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <Text
          numberOfLines={1}
          style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}
        >
          {session.title}
        </Text>
        <Text style={[textType.small, { color: colors.muted }]}>
          {new Date(session.updatedAt).toLocaleDateString("zh-CN", {
            month: "long",
            day: "numeric",
          })}{" "}
          · {session.messages.filter((m) => m.role === "user").length} 条消息
        </Text>
      </View>
      <ChevronRight size={16} color={colors.muted} />
    </Pressable>
  );
}

export function HomeScreen({
  workspace,
  start,
  open,
}: {
  workspace: WorkspaceController;
  start: (prompt?: string) => void;
  open: (id: string) => void;
}) {
  const { colors, dark } = useTheme();
  const { width } = useWindowDimensions();
  const roomy = width >= 900;
  return (
    <ScrollView
      contentContainerStyle={[
        styles.page,
        roomy && { paddingHorizontal: 48, paddingTop: 36 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <Reveal>
        <View style={styles.topline}>
          <Label color={colors.accent}>
            A LITTLE SPACE. A NEW POSSIBILITY.
          </Label>
          <View style={[styles.tinyDot, { backgroundColor: colors.accent }]} />
        </View>
      </Reveal>
      <Reveal delay={70}>
        <View
          style={[
            styles.hero,
            roomy && { flexDirection: "row", alignItems: "center" },
          ]}
        >
          <View style={{ flex: 1, minWidth: roomy ? 280 : undefined }}>
            <Text
              style={[textType.hero, { color: colors.text, marginTop: 22 }]}
            >
              想法，从这里{"\n"}
              <Text style={{ color: colors.accent }}>开始发生。</Text>
            </Text>
            <Text
              style={[
                textType.body,
                { color: colors.secondary, marginTop: 14 },
              ]}
            >
              你的工具、灵感与日常。{"\n"}在一个安静的空间里，慢慢连接。
            </Text>
          </View>
          <View style={roomy ? { width: 260 } : { marginTop: -4 }}>
            <Orb />
            <View
              style={{
                alignItems: "center",
                marginTop: -14,
                marginBottom: roomy ? 0 : 24,
              }}
            >
              <Label>SPACE TO THINK · ROOM TO CREATE</Label>
            </View>
          </View>
        </View>
      </Reveal>
      <Reveal delay={150}>
        <Button onPress={() => start()}>
          {workspace.busy ? "回到正在进行的对话" : "开启一段对话"}
        </Button>
        <View style={styles.mode}>
          <View style={[styles.tinyDot, { backgroundColor: colors.success }]} />
          <Text style={[textType.small, { color: colors.muted }]}>
            {workspace.state.provider === "offline"
              ? "本地演示已就绪 · 无需 API Key"
              : workspace.state.provider === "codex"
                ? "DSH 已连接 Codex 订阅"
                : "DSH 演示服务 · 无需 API Key"}
          </Text>
        </View>
      </Reveal>
      <Reveal delay={220} style={{ marginTop: roomy ? 32 : 22 }}>
        <SectionHeading title="给想法一个起点" meta="01 / EXPLORE" />
        <View style={styles.prompts}>
          {[
            {
              icon: Sun,
              title: "安排今天",
              detail: "把日常，理得轻一点",
              prompt: "帮我安排今天的计划",
            },
            {
              icon: Lightbulb,
              title: "梳理灵感",
              detail: "让零散想法，有个方向",
              prompt: "帮我梳理一个新想法",
            },
          ].map(({ icon: Icon, title, detail, prompt }) => (
            <Pressable
              key={title}
              accessibilityRole="button"
              accessibilityLabel={title}
              onPress={() => start(prompt)}
              style={({ pressed }) => [
                styles.prompt,
                {
                  backgroundColor: pressed ? colors.elevated : colors.surface,
                  borderColor: colors.border,
                },
              ]}
            >
              <View style={styles.promptTop}>
                <Icon color={colors.accent} size={21} strokeWidth={1.4} />
                <ArrowUpRight size={15} color={colors.muted} />
              </View>
              <Text
                style={{
                  color: colors.text,
                  fontFamily: fonts.medium,
                  fontSize: 15,
                  marginTop: 23,
                }}
              >
                {title}
              </Text>
              <Text
                style={{
                  color: colors.muted,
                  fontFamily: fonts.body,
                  fontSize: 11,
                  lineHeight: 20,
                  marginTop: 6,
                }}
              >
                {detail}
              </Text>
            </Pressable>
          ))}
        </View>
      </Reveal>
      <Reveal delay={290} style={{ marginTop: 30 }}>
        <SectionHeading
          title="最近的对话"
          meta={String(workspace.state.sessions.length).padStart(2, "0")}
        />
        {workspace.state.sessions.length ? (
          workspace.state.sessions.slice(0, 3).map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              onPress={() => {
                if (!workspace.busy || workspace.active?.id === s.id)
                  open(s.id);
              }}
            />
          ))
        ) : (
          <View style={[styles.empty, { borderColor: colors.border }]}>
            <Clock3 size={20} color={colors.muted} strokeWidth={1.4} />
            <Text style={[textType.small, { color: colors.muted }]}>
              从第一句开始，记录会留在这里。
            </Text>
          </View>
        )}
      </Reveal>
      <View
        style={{ marginTop: 36, alignItems: "center", opacity: dark ? 0.8 : 1 }}
      >
        <Label>MADE FOR YOUR EVERYDAY.</Label>
      </View>
    </ScrollView>
  );
}

export function HistoryScreen({
  workspace,
  open,
  start,
}: {
  workspace: WorkspaceController;
  open: (id: string) => void;
  start: () => void;
}) {
  const { colors } = useTheme();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Reveal>
        <Label>YOUR ARCHIVE</Label>
        <Text style={[textType.title, { color: colors.text, marginTop: 14 }]}>
          每一次思考，都有迹可循。
        </Text>
        <Text
          style={[
            textType.body,
            { color: colors.secondary, marginTop: 8, marginBottom: 28 },
          ]}
        >
          共 {workspace.state.sessions.length} 段对话，保存在本机。
        </Text>
      </Reveal>
      {workspace.busy ? (
        <Text
          style={[textType.small, { color: colors.accent, marginBottom: 16 }]}
        >
          当前回复完成后，可以切换或删除会话。
        </Text>
      ) : null}
      {workspace.state.sessions.map((s) => (
        <View key={s.id}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <SessionRow
                session={s}
                onPress={() => {
                  if (!workspace.busy) open(s.id);
                }}
              />
            </View>
            <IconButton
              icon={Trash2}
              label={`删除会话：${s.title}`}
              disabled={workspace.busy}
              onPress={() => setConfirmId(s.id)}
            />
          </View>
          {confirmId === s.id ? (
            <View style={[styles.confirm, { backgroundColor: colors.soft }]}>
              <Text style={[textType.small, { color: colors.text }]}>
                删除这段本地对话？
              </Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                <Button secondary compact onPress={() => setConfirmId(null)}>
                  保留
                </Button>
                <Button
                  compact
                  icon={Trash2}
                  onPress={() => {
                    workspace.removeChat(s.id);
                    setConfirmId(null);
                  }}
                >
                  删除
                </Button>
              </View>
            </View>
          ) : null}
        </View>
      ))}
      {!workspace.state.sessions.length ? (
        <View style={{ alignItems: "center", paddingVertical: 60, gap: 18 }}>
          <AuraMark size={56} />
          <Text style={[textType.body, { color: colors.secondary }]}>
            这里还很安静。
          </Text>
          <Button onPress={start} icon={Plus}>
            写下第一个想法
          </Button>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 24,
    paddingTop: 25,
    paddingBottom: 32,
    width: "100%",
    maxWidth: 940,
    alignSelf: "center",
  },
  topline: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tinyDot: { width: 5, height: 5, borderRadius: 3 },
  hero: { marginBottom: 6 },
  mode: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    justifyContent: "center",
    marginTop: 12,
  },
  prompts: { flexDirection: "row", gap: 12 },
  prompt: { flex: 1, borderWidth: 1, borderRadius: 18, padding: 17 },
  promptTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  session: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sessionIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
  },
  empty: {
    minHeight: 76,
    borderStyle: "dashed",
    borderWidth: 1,
    borderRadius: 16,
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  confirm: { padding: 16, borderRadius: 14, marginVertical: 8 },
});
