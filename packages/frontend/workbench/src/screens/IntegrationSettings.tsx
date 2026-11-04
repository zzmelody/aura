import React, { useEffect, useState } from "react";
import { Switch } from "@aura/ui/web";
import type {
  IntegrationFlags,
  IntegrationSettings,
  IntegrationUpdate,
  MarketListing,
  McpServerInput,
} from "@aura/protocol/types";
import { integrationRequest, useIntegrations } from "../integrations.tsx";
import { openExternal } from "../platform.ts";
import "./integration-settings.css";

const features = [
  [
    "mcp",
    "MCP 服务器",
    "在对话中使用已连接服务器的工具。工具调用占用对话能力中的额外请求额度。",
  ],
  [
    "market",
    "DSH 插件市场",
    "按名称搜索 DSH 插件并查看来源。Aura 插件目录仍在「插件」中管理。",
  ],
  [
    "voice",
    "语音输入",
    "使用 SenseVoice 在 Aura 服务所在设备识别语音，并将文字放入草稿。",
  ],
  [
    "agentTeam",
    "Agent 团队",
    "允许对话创建具名队友和共享任务。队友的模型请求占用额外请求额度。",
  ],
  [
    "sessionSearch",
    "会话全文搜索",
    "按对话正文搜索当前工作空间内已保存的会话。",
  ],
] as const satisfies ReadonlyArray<
  readonly [keyof IntegrationFlags, string, string]
>;

const voiceLabels: Record<string, string> = {
  unavailable: "服务不可用",
  unprepared: "待准备",
  checking: "正在检查文件",
  downloading: "正在下载模型",
  loading: "正在加载模型",
  waking: "正在唤醒模型",
  cancelling: "正在取消",
  ready: "已就绪",
  standby: "已就绪",
  failed: "准备失败",
  cancelled: "准备已取消",
};
const mcpLabels = {
  disabled: "已停用",
  connecting: "连接中",
  connected: "已连接",
  unavailable: "连接失败",
};
const voiceBusy = new Set(["checking", "downloading", "loading", "cancelling"]);

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成。";
}

export function IntegrationSettingsPanel({ endpoint }: { endpoint: string }) {
  const [state, setState] = useState<IntegrationSettings>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { apply } = useIntegrations();

  useEffect(() => {
    const abort = new AbortController();
    void integrationRequest<IntegrationSettings>(endpoint, "/settings", {
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) setState(value);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(errorText(cause));
      });
    return () => abort.abort();
  }, [endpoint]);

  useEffect(() => {
    if (
      saving ||
      !state ||
      (!voiceBusy.has(state.voicePhase) &&
        !state.mcpServers.some(({ status }) => status === "connecting"))
    )
      return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void integrationRequest<IntegrationSettings>(endpoint, "/settings", {
        signal: abort.signal,
      })
        .then((value) => {
          if (!abort.signal.aborted) setState(value);
        })
        .catch((cause: unknown) => {
          if (!abort.signal.aborted) setError(errorText(cause));
        });
    }, 1500);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [endpoint, saving, state]);

  async function save(patch: Omit<IntegrationUpdate, "revision">) {
    if (!state || saving) return false;
    setSaving(true);
    setError("");
    try {
      const next = await integrationRequest<IntegrationSettings>(
        endpoint,
        "/settings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: state.revision, ...patch }),
        },
      );
      setState(next);
      apply(next.flags);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      await refresh();
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function refresh() {
    try {
      const next = await integrationRequest<IntegrationSettings>(
        endpoint,
        "/settings",
      );
      setState(next);
      apply(next.flags);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function prepareVoice() {
    if (!state || saving) return;
    setSaving(true);
    setError("");
    try {
      const action = voiceBusy.has(state.voicePhase) ? "cancel" : "prepare";
      await integrationRequest(endpoint, `/voice/${action}`, {
        method: "POST",
      });
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {error ? (
        <p className="dsh-page-notice" role="alert">
          {error}
        </p>
      ) : null}
      {!state ? (
        <button
          type="button"
          className="dsh-button"
          onClick={() => {
            setError("");
            void refresh();
          }}
        >
          重新读取功能设置
        </button>
      ) : (
        <>
          <div className="settings-group">
            {features.map(([key, title, description]) => (
              <div className="settings-row" key={key}>
                <span className="settings-row-copy">
                  <strong>{title}</strong>
                  <span>{description}</span>
                </span>
                <Switch
                  accessibilityLabel={title}
                  value={state.flags[key]}
                  disabled={saving}
                  trackColor={{ false: "var(--border)", true: "var(--accent)" }}
                  onValueChange={(checked) =>
                    void save({ flags: { ...state.flags, [key]: checked } })
                  }
                />
              </div>
            ))}
          </div>
          {state.flags.mcp ? (
            <McpServers
              state={state}
              saving={saving}
              save={save}
              refresh={() => void refresh()}
            />
          ) : null}
          {state.flags.voice ? (
            <div className="settings-group integration-section">
              <div className="settings-row">
                <span className="settings-row-copy">
                  <strong>
                    SenseVoice 本地模型 ·{" "}
                    {voiceLabels[state.voicePhase] ?? state.voicePhase}
                  </strong>
                  <span>首次准备约需下载 239 MB 模型和附加文件。</span>
                </span>
                <button
                  type="button"
                  className="dsh-button"
                  disabled={
                    saving ||
                    [
                      "ready",
                      "standby",
                      "waking",
                      "unavailable",
                      "cancelling",
                    ].includes(state.voicePhase)
                  }
                  onClick={() => void prepareVoice()}
                >
                  {voiceBusy.has(state.voicePhase) ? "取消准备" : "准备模型"}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function McpServers({
  state,
  saving,
  save,
  refresh,
}: {
  state: IntegrationSettings;
  saving: boolean;
  save: (patch: Omit<IntegrationUpdate, "revision">) => Promise<boolean>;
  refresh: () => void;
}) {
  const [transport, setTransport] =
    useState<McpServerInput["transport"]>("streamable-http");
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    setError("");
    const name = text("name");
    let server: McpServerInput;
    if (transport === "stdio") {
      let args: unknown;
      try {
        args = JSON.parse(text("args") || "[]");
      } catch {
        /* Checked below. */
      }
      if (
        !Array.isArray(args) ||
        !args.every((item) => typeof item === "string")
      ) {
        setError("启动参数必须是 JSON 字符串数组。");
        return;
      }
      let env: unknown;
      try {
        env = JSON.parse(text("env") || "{}");
      } catch {
        /* Checked below. */
      }
      if (
        !env ||
        typeof env !== "object" ||
        Array.isArray(env) ||
        !Object.values(env).every((item) => typeof item === "string")
      ) {
        setError("环境变量映射必须是 JSON 对象，值为后端环境变量名。");
        return;
      }
      server = {
        name,
        transport,
        command: text("command"),
        args,
        env: env as Record<string, string>,
      };
    } else {
      server = {
        name,
        transport,
        url: text("url"),
        bearerEnv: text("bearerEnv") || undefined,
      };
    }
    if (await save({ server })) form.reset();
  }

  return (
    <section className="integration-section" aria-label="MCP 服务器">
      <div className="integration-toolbar">
        <h3 className="settings-subhead">MCP 服务器</h3>
        <button className="dsh-button" type="button" onClick={refresh}>
          刷新状态
        </button>
      </div>
      {state.mcpServers.length ? (
        <ul className="integration-list">
          {state.mcpServers.map((server) => (
            <li key={server.name}>
              <div>
                <strong>{server.name}</strong>
                <p>
                  {server.transport} · {mcpLabels[server.status]} ·{" "}
                  {server.tools.length} 个工具
                </p>
              </div>
              <button
                type="button"
                className="dsh-button"
                disabled={saving}
                aria-label={`移除 ${server.name}`}
                onClick={() => void save({ removeServer: server.name })}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="integration-form settings-group"
        onSubmit={(event) => void submit(event)}
      >
        <p>
          使用可信服务器。STDIO 会在 Aura
          服务所在设备执行命令。用同名配置可更新服务器。
        </p>
        <label>
          服务器名
          <input required name="name" maxLength={32} placeholder="github" />
        </label>
        <label>
          连接方式
          <select
            value={transport}
            onChange={(event) =>
              setTransport(
                event.target.value === "stdio" ? "stdio" : "streamable-http",
              )
            }
          >
            <option value="streamable-http">Streamable HTTP</option>
            <option value="stdio">STDIO</option>
          </select>
        </label>
        {transport === "stdio" ? (
          <>
            <label>
              启动命令
              <input required name="command" placeholder="node" />
            </label>
            <label>
              启动参数
              <input name="args" placeholder='["server.js"]' />
            </label>
            <label>
              环境变量映射
              <input
                name="env"
                placeholder='{"GITHUB_TOKEN":"AURA_MCP_GITHUB_TOKEN"}'
              />
            </label>
          </>
        ) : (
          <>
            <label>
              服务器地址
              <input
                required
                name="url"
                type="url"
                placeholder="https://example.com/mcp"
              />
            </label>
            <label>
              Bearer 环境变量名
              <input name="bearerEnv" placeholder="AURA_MCP_GITHUB_TOKEN" />
            </label>
          </>
        )}
        {error ? (
          <p role="alert" className="dsh-page-notice">
            {error}
          </p>
        ) : null}
        <button type="submit" className="dsh-button" disabled={saving}>
          保存服务器
        </button>
      </form>
    </section>
  );
}

export function PluginMarket({ endpoint }: { endpoint: string }) {
  const { flags } = useIntegrations();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketListing[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function search(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      setItems(
        await integrationRequest<MarketListing[]>(
          endpoint,
          `/market?q=${encodeURIComponent(query)}`,
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }
  if (!flags?.market) return null;
  return (
    <section
      className="integration-section"
      aria-labelledby="integration-market-title"
    >
      <h3 className="settings-subhead" id="integration-market-title">
        DSH 插件市场
      </h3>
      <form
        className="integration-toolbar"
        onSubmit={(event) => void search(event)}
      >
        <input
          aria-label="搜索 DSH 插件"
          placeholder="插件名或关键词"
          value={query}
          maxLength={256}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="dsh-button" type="submit" disabled={loading}>
          {loading ? "正在搜索…" : "搜索市场"}
        </button>
      </form>
      {error ? (
        <p className="dsh-page-notice" role="alert">
          {error}
        </p>
      ) : null}
      {items?.length === 0 ? (
        <p className="dsh-page-empty">没有匹配的插件。</p>
      ) : null}
      <ul className="integration-list">
        {items?.map((entry) => (
          <li key={entry.name}>
            <div>
              <strong>{entry.title}</strong>
              <p>
                {entry.name} · {entry.version}
              </p>
              <p>{entry.description}</p>
            </div>
            {entry.sourceUrl ? (
              <a
                href={entry.sourceUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (!window.auraHost?.openExternal) return;
                  event.preventDefault();
                  void openExternal(event.currentTarget.href).catch(
                    (cause: unknown) => setError(errorText(cause)),
                  );
                }}
              >
                查看来源
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
