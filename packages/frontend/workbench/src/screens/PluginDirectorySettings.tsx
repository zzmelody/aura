import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiErrorText } from "../api-error-messages.ts";
import {
  errorMessage,
  formatNumber,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  detailMessage,
  useSettingsDetailsMessages,
} from "./settings-details-messages.ts";
import type {
  AuraPluginSettingsState,
  AuraPluginStatus,
} from "@aura/protocol/types";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "@aura/ui/web";
import {
  AlertTriangle,
  Check,
  FolderPlus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Label, useTheme } from "@aura/ui/components";
import { fonts, type as textType } from "@aura/ui/theme";
import {
  editablePluginEntries,
  readPluginSettings,
  savePluginSettings,
} from "../pluginSettings.ts";

interface DraftEntry {
  key: number;
  path: string;
  enabled: boolean;
}

function problemMessage(cause: unknown): string | MessageReference {
  return errorMessage(cause, detailMessage("pluginSettingsUnavailable"));
}

function statusLabel(
  status: AuraPluginStatus | undefined,
  enabled: boolean,
  t: ReturnType<typeof useSettingsDetailsMessages>["t"],
  runtime: Parameters<typeof messageText>[1],
) {
  if (!status) return t("awaitingValidation");
  if (!enabled) return t("pluginDisabled");
  if (status.available)
    return `${status.name}${status.version ? ` · v${status.version}` : ""}`;
  return messageText(
    apiErrorText(status.errorDetails, status.error || t("pluginUnavailable")),
    runtime,
  );
}

export function PluginDirectorySettings({ endpoint }: { endpoint: string }) {
  const { t, i18n } = useSettingsDetailsMessages();
  const { colors } = useTheme();
  const nextKey = useRef(0);
  const [settings, setSettings] = useState<AuraPluginSettingsState>();
  const [entries, setEntries] = useState<DraftEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | MessageReference>("");
  const [notice, setNotice] = useState<string | MessageReference>("");

  const replaceEntries = useCallback((state: AuraPluginSettingsState) => {
    setSettings(state);
    setEntries(
      editablePluginEntries(state).map((entry) => ({
        ...entry,
        key: nextKey.current++,
      })),
    );
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const state = await readPluginSettings(endpoint, signal);
        if (!signal?.aborted) replaceEntries(state);
      } catch (cause) {
        if (!signal?.aborted) setError(problemMessage(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [endpoint, replaceEntries],
  );

  useEffect(() => {
    const abort = new AbortController();
    setSettings(undefined);
    setEntries([]);
    setNotice("");
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);

  const dirty = useMemo(
    () =>
      JSON.stringify(
        entries.map(({ path, enabled }) => ({ path, enabled })),
      ) !== JSON.stringify(settings ? editablePluginEntries(settings) : []),
    [entries, settings],
  );

  async function save() {
    const plugins = entries.map(({ path, enabled }) => ({
      path: path.trim(),
      enabled,
    }));
    if (plugins.some(({ path }) => !path)) {
      setError(detailMessage("pluginPathRequired"));
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const state = await savePluginSettings(endpoint, { plugins });
      replaceEntries(state);
      const unavailable = state.plugins.filter(
        ({ enabled, status }) => enabled && !status.available,
      ).length;
      if (unavailable)
        setError(
          detailMessage("pluginsFailedValidation", { count: unavailable }),
        );
      else setNotice(detailMessage("pluginDirectoriesSaved"));
    } catch (cause) {
      setError(problemMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const activeCount =
    settings?.active.filter(({ available }) => available).length ?? 0;

  return (
    <View
      style={[
        styles.bay,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.heading}>
        <ShieldCheck size={16} color={colors.secondary} />
        <Text style={[textType.small, { color: colors.secondary, flex: 1 }]}>
          {t("trustedDirectoriesHint")}
        </Text>
        <View style={[styles.counter, { backgroundColor: colors.soft }]}>
          <Text
            style={{
              color: colors.accent,
              fontFamily: fonts.mono,
              fontSize: 10,
            }}
          >
            {t("enabledCount", { count: activeCount })}
          </Text>
        </View>
      </View>

      {loading && !settings ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[textType.small, { color: colors.muted }]}>
            {t("readingLocalConfig")}
          </Text>
        </View>
      ) : null}

      {!loading && !settings ? (
        <View style={[styles.problem, { backgroundColor: colors.input }]}>
          <AlertTriangle size={18} color={colors.danger} />
          <View style={{ flex: 1, gap: 5 }}>
            <Text
              accessibilityRole="alert"
              style={[textType.small, { color: colors.text }]}
            >
              {messageText(error, i18n)}
            </Text>
            <Text style={[textType.small, { color: colors.muted }]}>
              {t("localOnly")}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={t("reloadDirectories")}
            onPress={() => void refresh()}
            style={[styles.iconButton, { borderColor: colors.border }]}
          >
            <RefreshCw size={16} color={colors.secondary} />
          </Pressable>
        </View>
      ) : null}

      {settings ? (
        <>
          <View style={styles.entries}>
            {entries.map((entry, index) => {
              const persistedEntry = settings.plugins.find(
                (item) =>
                  item.path === entry.path && item.enabled === entry.enabled,
              );
              const status = persistedEntry?.status;
              const statusColor = !status
                ? colors.muted
                : !entry.enabled
                  ? colors.muted
                  : status.available
                    ? colors.success
                    : colors.danger;
              return (
                <View
                  key={entry.key}
                  style={[styles.entry, { borderColor: colors.border }]}
                >
                  <View style={styles.entryRail}>
                    <Text style={[styles.index, { color: colors.muted }]}>
                      {formatNumber(index + 1, { minimumIntegerDigits: 2 })}
                    </Text>
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusColor },
                      ]}
                    />
                  </View>
                  <View style={styles.entryContent}>
                    <View style={styles.entryTopline}>
                      <Label>{t("trustedDirectory")}</Label>
                      <Pressable
                        accessibilityLabel={t("removeDirectory", {
                          index: index + 1,
                        })}
                        onPress={() =>
                          setEntries((current) =>
                            current.filter(({ key }) => key !== entry.key),
                          )
                        }
                        style={styles.remove}
                      >
                        <Trash2 size={15} color={colors.muted} />
                      </Pressable>
                    </View>
                    <TextInput
                      accessibilityLabel={t("directory", { index: index + 1 })}
                      value={entry.path}
                      onChangeText={(path) =>
                        setEntries((current) =>
                          current.map((item) =>
                            item.key === entry.key ? { ...item, path } : item,
                          ),
                        )
                      }
                      placeholder="D:/aura-plugins/my-plugin"
                      placeholderTextColor={colors.muted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={[
                        styles.path,
                        {
                          color: colors.text,
                          backgroundColor: colors.input,
                          borderColor: colors.border,
                        },
                      ]}
                    />
                    <View style={styles.entryFooter}>
                      <View style={{ flex: 1, gap: 3 }}>
                        <Text style={[styles.status, { color: statusColor }]}>
                          {statusLabel(status, entry.enabled, t, i18n)}
                        </Text>
                        <Text style={[textType.small, { color: colors.muted }]}>
                          {entry.enabled
                            ? t("loadNextStart")
                            : t("keepDisabled")}
                        </Text>
                      </View>
                      <Switch
                        accessibilityLabel={t("enableDirectory", {
                          index: index + 1,
                        })}
                        value={entry.enabled}
                        onValueChange={(enabled) =>
                          setEntries((current) =>
                            current.map((item) =>
                              item.key === entry.key
                                ? { ...item, enabled }
                                : item,
                            ),
                          )
                        }
                        trackColor={{
                          false: colors.border,
                          true: colors.primary,
                        }}
                        thumbColor={
                          entry.enabled ? colors.primaryText : colors.primary
                        }
                      />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>

          <Pressable
            accessibilityLabel={t("addExternalDirectory")}
            onPress={() =>
              setEntries((current) => [
                ...current,
                { key: nextKey.current++, path: "", enabled: false },
              ])
            }
            style={[styles.add, { borderColor: colors.border }]}
          >
            <FolderPlus size={17} color={colors.accent} />
            <Text style={[textType.small, { color: colors.accent }]}>
              {t("addDirectory")}
            </Text>
            <Text
              style={[
                textType.small,
                { color: colors.muted, marginLeft: "auto" },
              ]}
            >
              {t("disabledByDefault")}
            </Text>
          </Pressable>

          {settings.applyRequired ? (
            <View style={[styles.restart, { backgroundColor: colors.soft }]}>
              <AlertTriangle size={16} color={colors.accent} />
              <Text style={[textType.small, { color: colors.accent, flex: 1 }]}>
                {t("externalConfigChanged")}
              </Text>
            </View>
          ) : null}

          {error ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[textType.small, { color: colors.danger }]}
            >
              {messageText(error, i18n)}
            </Text>
          ) : null}
          {notice ? (
            <View style={styles.notice}>
              <Check size={15} color={colors.success} />
              <Text
                accessibilityLiveRegion="polite"
                style={[textType.small, { color: colors.success, flex: 1 }]}
              >
                {messageText(notice, i18n)}
              </Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <View style={{ flex: 1, minWidth: 180, gap: 3 }}>
              <Label>{t("configFile")}</Label>
              <Text
                numberOfLines={1}
                selectable
                style={{
                  color: colors.muted,
                  fontFamily: fonts.mono,
                  fontSize: 10,
                }}
              >
                {settings.configPath}
              </Text>
            </View>
            <button
              type="button"
              className="tool-button"
              disabled={loading || saving}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} />
              {t("reload")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || loading || saving}
              onClick={() => void save()}
            >
              <Save size={14} />
              {saving ? t("validating") : t("saveDirectories")}
            </button>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bay: {
    padding: 16,
    borderRadius: "calc(12px * var(--radius-scale, 1))",
    borderWidth: 1,
    gap: 14,
  },
  heading: { flexDirection: "row", alignItems: "center", gap: 12 },
  counter: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  loading: {
    minHeight: 110,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  problem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: "calc(8px * var(--radius-scale, 1))",
  },
  iconButton: {
    width: 32,
    height: 32,
    borderWidth: 1,
    borderRadius: "calc(7px * var(--radius-scale, 1))",
    alignItems: "center",
    justifyContent: "center",
  },
  entries: { gap: 10 },
  entry: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: "calc(9px * var(--radius-scale, 1))",
    overflow: "hidden",
  },
  entryRail: { width: 38, alignItems: "center", paddingTop: 15, gap: 10 },
  entryContent: { flex: 1, gap: 10, padding: 13, paddingLeft: 0 },
  index: { fontFamily: fonts.mono, fontSize: 9 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  entryTopline: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  remove: { padding: 3 },
  path: {
    fontFamily: fonts.mono,
    fontSize: 12,
    minHeight: 43,
    borderWidth: 1,
    borderRadius: "calc(8px * var(--radius-scale, 1))",
    paddingHorizontal: 12,
  },
  entryFooter: { flexDirection: "row", alignItems: "center", gap: 12 },
  status: { fontFamily: fonts.medium, fontSize: 11 },
  add: {
    minHeight: 45,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: "calc(8px * var(--radius-scale, 1))",
  },
  restart: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    padding: 11,
    borderRadius: "calc(7px * var(--radius-scale, 1))",
  },
  notice: { flexDirection: "row", alignItems: "center", gap: 7 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 9,
  },
});
