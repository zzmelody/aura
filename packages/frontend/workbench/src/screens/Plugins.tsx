import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MetadataOwner, metadataText } from "../metadata.ts";
import { apiErrorText } from "../api-error-messages.ts";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  detailMessage,
  useSettingsDetailsMessages,
} from "./settings-details-messages.ts";
import type {
  AuraPluginSettingsEntry,
  AuraPluginSettingsState,
} from "@aura/protocol/types";
import { Blocks, RefreshCw } from "lucide-react";
import {
  editablePluginEntries,
  readPluginSettings,
  savePluginSettings,
} from "../pluginSettings.ts";
import "./plugins.css";

function problemMessage(cause: unknown): string | MessageReference {
  return errorMessage(cause, detailMessage("pluginListUnavailable"));
}

function pluginTitle(
  entry: AuraPluginSettingsEntry,
  runtime: Parameters<typeof metadataText>[3],
): string {
  return entry.status.available || entry.status.id
    ? metadataText(entry.status, "name", entry.status.name, runtime)
    : (entry.path.split(/[\\/]/u).at(-1) ?? entry.path);
}

function pluginTags(entry: AuraPluginSettingsEntry, problem: string) {
  const tags: Array<{ id: string; label: string; problem?: boolean }> = [];
  if (entry.status.version)
    tags.push({ id: "version", label: `v${entry.status.version}` });
  if (entry.enabled && !entry.status.available)
    tags.push({ id: "problem", label: problem, problem: true });
  return tags;
}

/**
 * DSH-style plugin manager: one card per plugin, grouped into the plugins that
 * ship with Aura and the ones added by directory. Toggling saves the shared
 * plugin configuration at once. It sits in the Settings plugins section, above
 * the directory editor, rather than on a navigation page of its own.
 */
export function PluginList({
  endpoint,
  settingsPages,
  onOpenSettings,
}: {
  endpoint: string;
  settingsPages: ReadonlyMap<string, `plugin:${string}`>;
  onOpenSettings(tab: `plugin:${string}`): void;
}) {
  const { t, i18n } = useSettingsDetailsMessages();
  const metadata = useMemo(() => new MetadataOwner(i18n), [i18n]);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const [state, setState] = useState<AuraPluginSettingsState>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState<string | MessageReference>("");

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const next = await readPluginSettings(endpoint, signal);
        if (
          !signal?.aborted &&
          metadata.active &&
          endpointRef.current === endpoint
        )
          setState(metadata.settings(next));
      } catch (cause) {
        if (!signal?.aborted) setError(problemMessage(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [endpoint, metadata],
  );

  useEffect(() => {
    const abort = new AbortController();
    metadata.activate();
    void refresh(abort.signal);
    return () => {
      abort.abort();
      metadata.dispose();
    };
  }, [refresh, metadata]);

  async function toggle(path: string, enabled: boolean) {
    if (!state) return;
    setSaving(path);
    setError("");
    try {
      const next = await savePluginSettings(endpoint, {
        plugins: editablePluginEntries(state).map((entry) =>
          entry.path === path ? { ...entry, enabled } : entry,
        ),
      });
      if (metadata.active && endpointRef.current === endpoint)
        setState(metadata.settings(next));
    } catch (cause) {
      setError(problemMessage(cause));
    } finally {
      setSaving(undefined);
    }
  }

  const groups = state
    ? [
        {
          id: "builtin",
          title: t("builtinPlugins"),
          items: state.plugins.filter(({ builtin }) => builtin),
        },
        {
          id: "installed",
          title: t("addedPlugins"),
          items: state.plugins.filter(({ builtin }) => !builtin),
        },
      ].filter(({ items }) => items.length)
    : [];

  return (
    <div className="plugins-manager">
      <div className="plugins-manager-head">
        <span>{t("installedPlugins")}</span>
        <button
          type="button"
          className="dsh-button"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} />
          {t("refresh")}
        </button>
      </div>
      {error ? (
        <p className="dsh-page-notice" role="alert">
          {messageText(error, i18n)}
        </p>
      ) : null}
      {state?.applyRequired ? (
        <p className="dsh-page-notice">{t("toggleToApply")}</p>
      ) : null}
      {loading && !state ? (
        <p className="dsh-page-empty">{t("loadingPlugins")}</p>
      ) : null}
      {state && !state.plugins.length ? (
        <p className="dsh-page-empty">{t("noPlugins")}</p>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.id}
          className="plugins-group"
          aria-labelledby={`plugins-${group.id}`}
        >
          <h3 id={`plugins-${group.id}`}>{group.title}</h3>
          <ul className="plugins-list">
            {group.items.map((entry) => {
              const title = pluginTitle(entry, i18n);
              const failed = entry.enabled && !entry.status.available;
              const problem = messageText(
                apiErrorText(
                  entry.status.errorDetails,
                  entry.status.error ?? t("pluginUnavailable"),
                ),
                i18n,
              );
              const settingsPage =
                entry.enabled && entry.status.available && entry.status.id
                  ? settingsPages.get(entry.status.id)
                  : undefined;
              return (
                <li key={entry.path} className="plugins-card">
                  <span className="plugins-artwork" aria-hidden="true">
                    <Blocks size={22} />
                  </span>
                  <span className="plugins-text">
                    <span className="plugins-title">
                      <strong>{title}</strong>
                      {pluginTags(entry, t("problem")).map((tag) => (
                        <span
                          key={tag.id}
                          className={`plugins-tag${tag.problem ? " problem" : ""}`}
                        >
                          {tag.label}
                        </span>
                      ))}
                    </span>
                    <span
                      className="plugins-description"
                      title={failed ? problem : entry.path}
                    >
                      {failed
                        ? problem
                        : metadataText(
                            entry.status,
                            "description",
                            entry.status.description ?? entry.path,
                            i18n,
                          )}
                    </span>
                  </span>
                  {settingsPage ? (
                    <button
                      type="button"
                      className="tool-button"
                      aria-label={t("openPluginSettings", { title })}
                      onClick={() => onOpenSettings(settingsPage)}
                    >
                      {t("settings")}
                    </button>
                  ) : null}
                  <label className="dsh-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t("enablePlugin", { title })}
                      checked={entry.enabled}
                      disabled={saving !== undefined}
                      onChange={(event) =>
                        void toggle(entry.path, event.target.checked)
                      }
                    />
                    <span aria-hidden="true" />
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
