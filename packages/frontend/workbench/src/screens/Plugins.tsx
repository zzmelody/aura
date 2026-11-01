import React, { useCallback, useEffect, useState } from "react";
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

function problemMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "插件列表暂时不可用。";
}

function pluginTitle(entry: AuraPluginSettingsEntry): string {
  return entry.status.available || entry.status.id
    ? entry.status.name
    : (entry.path.split(/[\\/]/u).at(-1) ?? entry.path);
}

function pluginTags(entry: AuraPluginSettingsEntry): string[] {
  const tags: string[] = [];
  if (entry.status.version) tags.push(`v${entry.status.version}`);
  if (entry.enabled && !entry.status.available) tags.push("异常");
  return tags;
}

/**
 * DSH-style plugin manager: one card per plugin, grouped into the plugins that
 * ship with Aura and the ones added by directory. Toggling saves the shared
 * plugin configuration at once. It sits in the Settings plugins section, above
 * the directory editor, rather than on a navigation page of its own.
 */
export function PluginList({ endpoint }: { endpoint: string }) {
  const [state, setState] = useState<AuraPluginSettingsState>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState("");

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const next = await readPluginSettings(endpoint, signal);
        if (!signal?.aborted) setState(next);
      } catch (cause) {
        if (!signal?.aborted) setError(problemMessage(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);

  async function toggle(path: string, enabled: boolean) {
    if (!state) return;
    setSaving(path);
    setError("");
    try {
      setState(
        await savePluginSettings(endpoint, {
          plugins: editablePluginEntries(state).map((entry) =>
            entry.path === path ? { ...entry, enabled } : entry,
          ),
        }),
      );
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
          title: "内置插件",
          items: state.plugins.filter(({ builtin }) => builtin),
        },
        {
          id: "installed",
          title: "已添加的插件",
          items: state.plugins.filter(({ builtin }) => !builtin),
        },
      ].filter(({ items }) => items.length)
    : [];

  return (
    <div className="plugins-manager">
      <div className="plugins-manager-head">
        <span>已安装的插件</span>
        <button
          type="button"
          className="dsh-button"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>
      {error ? (
        <p className="dsh-page-notice" role="alert">
          {error}
        </p>
      ) : null}
      {state?.applyRequired ? (
        <p className="dsh-page-notice">
          配置文件在 Aura 外部发生了变化，切换任一插件即可应用。
        </p>
      ) : null}
      {loading && !state ? (
        <p className="dsh-page-empty">正在读取插件…</p>
      ) : null}
      {state && !state.plugins.length ? (
        <p className="dsh-page-empty">还没有插件</p>
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
              const title = pluginTitle(entry);
              const failed = entry.enabled && !entry.status.available;
              return (
                <li key={entry.path} className="plugins-card">
                  <span className="plugins-artwork" aria-hidden="true">
                    <Blocks size={22} />
                  </span>
                  <span className="plugins-text">
                    <span className="plugins-title">
                      <strong>{title}</strong>
                      {pluginTags(entry).map((tag) => (
                        <span
                          key={tag}
                          className={`plugins-tag${failed && tag === "异常" ? " problem" : ""}`}
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                    <span
                      className="plugins-description"
                      title={failed ? entry.status.error : entry.path}
                    >
                      {failed
                        ? (entry.status.error ?? "插件不可用")
                        : (entry.status.description ?? entry.path)}
                    </span>
                  </span>
                  <label className="dsh-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`启用 ${title}`}
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
