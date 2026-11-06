import React, { useEffect, useState } from "react";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  useIntegrationMessages,
  integrationMessage,
  type IntegrationMessageKey,
} from "./integration-messages.ts";
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
  ["mcp", "mcp", "mcpHint"],
  ["market", "market", "marketHint"],
  ["voice", "voice", "voiceHint"],
  ["agentTeam", "agentTeam", "agentTeamHint"],
  ["sessionSearch", "sessionSearch", "sessionSearchHint"],
] as const satisfies ReadonlyArray<
  readonly [
    keyof IntegrationFlags,
    IntegrationMessageKey,
    IntegrationMessageKey,
  ]
>;

const voiceLabels: Record<string, IntegrationMessageKey> = {
  unavailable: "unavailable",
  unprepared: "unprepared",
  checking: "checking",
  downloading: "downloading",
  loading: "loading",
  waking: "waking",
  cancelling: "cancelling",
  ready: "ready",
  standby: "ready",
  failed: "failed",
  cancelled: "cancelled",
};
const mcpLabels = {
  disabled: "disabled",
  connecting: "connecting",
  connected: "connected",
  unavailable: "connectionFailed",
} as const satisfies Record<string, IntegrationMessageKey>;
const voiceBusy = new Set(["checking", "downloading", "loading", "cancelling"]);

function errorText(error: unknown) {
  return errorMessage(error, integrationMessage("operationFailed"));
}

export function IntegrationSettingsPanel({ endpoint }: { endpoint: string }) {
  const [state, setState] = useState<IntegrationSettings>();
  const [saving, setSaving] = useState(false);
  const { t, i18n } = useIntegrationMessages();
  const [error, setError] = useState<string | MessageReference>("");
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
          {messageText(error, i18n)}
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
          {t("reloadSettings")}
        </button>
      ) : (
        <>
          <div className="settings-group">
            {features.map(([key, title, description]) => (
              <div className="settings-row" key={key}>
                <span className="settings-row-copy">
                  <strong>{t(title)}</strong>
                  <span>{t(description)}</span>
                </span>
                <Switch
                  accessibilityLabel={t(title)}
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
                    {t("voiceStatus", {
                      status: voiceLabels[state.voicePhase]
                        ? t(voiceLabels[state.voicePhase])
                        : state.voicePhase,
                    })}
                  </strong>
                  <span>{t("voiceDownloadHint")}</span>
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
                  {voiceBusy.has(state.voicePhase)
                    ? t("cancelPreparation")
                    : t("prepareModel")}
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
  const { t, i18n } = useIntegrationMessages();
  const [error, setError] = useState<string | MessageReference>("");
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
        setError(integrationMessage("invalidArguments"));
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
        setError(integrationMessage("invalidEnvironment"));
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
    <section className="integration-section" aria-label={t("mcp")}>
      <div className="integration-toolbar">
        <h3 className="settings-subhead">{t("mcp")}</h3>
        <button className="dsh-button" type="button" onClick={refresh}>
          {t("refreshStatus")}
        </button>
      </div>
      {state.mcpServers.length ? (
        <ul className="integration-list">
          {state.mcpServers.map((server) => (
            <li key={server.name}>
              <div>
                <strong>{server.name}</strong>
                <p>
                  {server.transport} · {t(mcpLabels[server.status])} ·{" "}
                  {t("toolCount", { count: server.tools.length })}
                </p>
              </div>
              <button
                type="button"
                className="dsh-button"
                disabled={saving}
                aria-label={t("removeServer", { name: server.name })}
                onClick={() => void save({ removeServer: server.name })}
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="integration-form settings-group"
        onSubmit={(event) => void submit(event)}
      >
        <p>{t("trustedServerHint")}</p>
        <label>
          {t("serverName")}
          <input required name="name" maxLength={32} placeholder="github" />
        </label>
        <label>
          {t("transport")}
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
              {t("command")}
              <input required name="command" placeholder="node" />
            </label>
            <label>
              {t("arguments")}
              <input name="args" placeholder='["server.js"]' />
            </label>
            <label>
              {t("environment")}
              <input
                name="env"
                placeholder='{"GITHUB_TOKEN":"AURA_MCP_GITHUB_TOKEN"}'
              />
            </label>
          </>
        ) : (
          <>
            <label>
              {t("serverUrl")}
              <input
                required
                name="url"
                type="url"
                placeholder="https://example.com/mcp"
              />
            </label>
            <label>
              {t("bearerVariable")}
              <input name="bearerEnv" placeholder="AURA_MCP_GITHUB_TOKEN" />
            </label>
          </>
        )}
        {error ? (
          <p role="alert" className="dsh-page-notice">
            {messageText(error, i18n)}
          </p>
        ) : null}
        <button type="submit" className="dsh-button" disabled={saving}>
          {t("saveServer")}
        </button>
      </form>
    </section>
  );
}

export function PluginMarket({ endpoint }: { endpoint: string }) {
  const { flags } = useIntegrations();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketListing[]>();
  const { t, i18n } = useIntegrationMessages();
  const [error, setError] = useState<string | MessageReference>("");
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
        {t("market")}
      </h3>
      <form
        className="integration-toolbar"
        onSubmit={(event) => void search(event)}
      >
        <input
          aria-label={t("searchPlugins")}
          placeholder={t("searchPlaceholder")}
          value={query}
          maxLength={256}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="dsh-button" type="submit" disabled={loading}>
          {loading ? t("searching") : t("searchMarket")}
        </button>
      </form>
      {error ? (
        <p className="dsh-page-notice" role="alert">
          {messageText(error, i18n)}
        </p>
      ) : null}
      {items?.length === 0 ? (
        <p className="dsh-page-empty">{t("noPlugins")}</p>
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
                {t("viewSource")}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
