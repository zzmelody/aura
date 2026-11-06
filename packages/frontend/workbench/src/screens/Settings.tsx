import React, { useEffect, useRef, useState } from "react";
import { Switch } from "@aura/ui/web";
import {
  Archive,
  Check,
  ChevronRight,
  Clock3,
  Info,
  Monitor,
  Moon,
  Palette,
  PlugZap,
  Radio,
  Sparkles,
  Sun,
  Wifi,
} from "lucide-react";
import { useTheme } from "@aura/ui/components";
import { validateEndpoint } from "@aura/core";
import type { ThemeMode, Workspace } from "@aura/core/types";
import type { WorkspaceController } from "../useWorkspace";
import type { CodexAuthController } from "../useCodexAuth";
import { CodexLoginButton } from "../CodexLoginButton";
import { PluginDirectorySettings } from "./PluginDirectorySettings.tsx";
import {
  IntegrationSettingsPanel,
  PluginMarket,
} from "./IntegrationSettings.tsx";
import { PluginList } from "./Plugins.tsx";
import { ModelServiceSettings } from "./ModelServiceSettings.tsx";
import { AppearanceSettings } from "./AppearanceSettings.tsx";
import { LanguageSettings } from "./LanguageSettings.tsx";
import { useWorkbenchMessages, type WorkbenchMessageKey } from "../i18n.ts";
import type { AppearanceController } from "../useAppearance.ts";
import {
  appearancePalette,
  type AppearancePreferences,
} from "../appearance.ts";
import "./settings.css";

const sections = [
  { id: "appearance", icon: Palette },
  { id: "models", icon: Sparkles },
  { id: "connection", icon: Wifi },
  { id: "features", icon: Radio },
  { id: "plugins", icon: PlugZap },
  { id: "records", icon: Clock3 },
  { id: "about", icon: Info },
] as const;
export type SettingsSectionId = (typeof sections)[number]["id"];

const themes: Array<{
  id: ThemeMode;
  icon: typeof Moon;
}> = [
  { id: "dark", icon: Moon },
  { id: "light", icon: Sun },
  { id: "system", icon: Monitor },
];

const providers: Array<{
  id: Workspace["provider"];
  title: WorkbenchMessageKey<"settings">;
  hint: WorkbenchMessageKey<"settings">;
}> = [
  { id: "offline", title: "offline", hint: "offlineHint" },
  { id: "codex", title: "codex", hint: "codexHint" },
  {
    id: "lumina",
    title: "lumina",
    hint: "luminaHint",
  },
  {
    id: "custom",
    title: "customApi",
    hint: "customApiHint",
  },
];

/** Miniature window drawn from one palette, so the choice previews itself. */
function ThemePreview({
  mode,
  preferences,
}: {
  mode: "dark" | "light";
  preferences: AppearancePreferences;
}) {
  const p = appearancePalette(mode === "dark", preferences);
  return (
    <span
      className="settings-theme-preview"
      style={{ background: p.background, borderColor: p.border }}
      aria-hidden="true"
    >
      <span style={{ background: p.surface, borderColor: p.border }}>
        <i style={{ background: p.soft }} />
        <i style={{ background: p.border }} />
        <i style={{ background: p.border }} />
      </span>
      <span>
        <i style={{ background: p.text, width: "58%" }} />
        <i style={{ background: p.secondary, width: "82%" }} />
        <i style={{ background: p.primary, width: "34%", height: 8 }} />
      </span>
    </span>
  );
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      {children ? <div className="settings-row-control">{children}</div> : null}
    </div>
  );
}

/** Open pages stay mounted so switching categories preserves form drafts. */
function SettingsPage({
  id,
  active,
  children,
}: {
  id: SettingsSectionId;
  active: SettingsSectionId;
  children: React.ReactNode;
}) {
  const current = active === id;
  const [visited, setVisited] = useState(current);
  useEffect(() => {
    if (current) setVisited(true);
  }, [current]);
  return (
    <section
      id={`settings-${id}`}
      aria-labelledby={`settings-${id}-title`}
      hidden={!current}
    >
      {current || visited ? children : null}
    </section>
  );
}

export function SettingsScreen({
  workspace,
  appearance,
  codexAuth,
  systemReduced,
  section,
  onSectionChange,
  pluginSettingsPages,
  onOpenPluginSettings,
  onHistory,
  onArchived,
}: {
  workspace: WorkspaceController;
  appearance: AppearanceController;
  codexAuth: CodexAuthController;
  systemReduced: boolean;
  /** The selected settings page, also used by workbench shortcuts. */
  section: SettingsSectionId;
  onSectionChange(section: SettingsSectionId): void;
  pluginSettingsPages: ReadonlyMap<string, `plugin:${string}`>;
  onOpenPluginSettings(tab: `plugin:${string}`): void;
  /** Opens the full conversation log. */
  onHistory(): void;
  /** Opens the sidebar filtered to archived conversations. */
  onArchived(): void;
}) {
  const { colors } = useTheme();
  const { t } = useWorkbenchMessages("settings");
  const [address, setAddress] = useState(
    workspace.state.endpoint || "http://127.0.0.1:4311",
  );
  const [connection, setConnection] = useState<{
    tone: "ok" | "error" | "info";
    text: WorkbenchMessageKey<"settings">;
  }>();
  const [checking, setChecking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [section]);

  useEffect(() => {
    const nav = navigation.current;
    const button = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !button) return;
    const reveal = () =>
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    reveal();
    return () => observer.disconnect();
  }, [section]);

  async function connect() {
    const endpoint = validateEndpoint(address);
    if (!endpoint) {
      setConnection({
        tone: "error",
        text: "addressInvalid",
      });
      return;
    }
    setChecking(true);
    setConnection(undefined);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const result = await fetch(`${endpoint}/health`, {
        signal: abort.signal,
      });
      const health = await result.json();
      if (
        !result.ok ||
        health.service !== "aura-runtime" ||
        !Array.isArray(health.modes) ||
        !health.modes.includes("dsh-demo")
      )
        throw new Error(t("wrongService"));
      workspace.setState((s) => ({ ...s, endpoint }));
      setConnection({ tone: "ok", text: "connected" });
    } catch (e) {
      setConnection({
        tone: "error",
        text:
          e instanceof Error && e.name !== "AbortError"
            ? "connectionFailed"
            : "connectionTimedOut",
      });
    } finally {
      clearTimeout(timeout);
      setChecking(false);
    }
  }

  const switchColors = { false: colors.border, true: colors.primary };
  const codex = codexAuth.status;
  const codexLabel =
    codex.state === "authenticated"
      ? t("signedIn")
      : codex.state === "pending"
        ? t("signingIn")
        : codex.state === "error"
          ? t("signInFailed")
          : t("signedOut");

  return (
    <div className="settings-page">
      <nav
        className="settings-nav"
        aria-label={t("categories")}
        ref={navigation}
      >
        <h1>{t("title")}</h1>
        {sections.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={section === id ? "selected" : ""}
            aria-current={section === id ? "page" : undefined}
            aria-controls={`settings-${id}`}
            onClick={() => onSectionChange(id)}
          >
            <Icon size={16} aria-hidden="true" />
            {t(id)}
          </button>
        ))}
      </nav>
      <div className="settings-scroll" ref={scroller}>
        <div className="settings-content">
          <SettingsPage id="appearance" active={section}>
            <header className="settings-section-head">
              <h2 id="settings-appearance-title">{t("appearance")}</h2>
              <p>{t("appearanceHint")}</p>
            </header>
            <LanguageSettings />
            <div
              className="settings-themes"
              role="radiogroup"
              aria-label={t("theme")}
            >
              {themes.map(({ id, icon: Icon }) => {
                const selected = workspace.state.theme === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`settings-theme${selected ? " selected" : ""}`}
                    onClick={() =>
                      workspace.setState((s) => ({ ...s, theme: id }))
                    }
                  >
                    {id === "system" ? (
                      <span className="settings-theme-split" aria-hidden="true">
                        <ThemePreview
                          mode="dark"
                          preferences={appearance.preferences}
                        />
                        <ThemePreview
                          mode="light"
                          preferences={appearance.preferences}
                        />
                      </span>
                    ) : (
                      <ThemePreview
                        mode={id}
                        preferences={appearance.preferences}
                      />
                    )}
                    <span className="settings-theme-label">
                      <Icon size={14} />
                      <strong>
                        {t(
                          id === "dark"
                            ? "night"
                            : id === "light"
                              ? "dawn"
                              : "system",
                        )}
                      </strong>
                      <span>{t(id === "system" ? "automatic" : id)}</span>
                      {selected ? (
                        <Check size={14} className="settings-check" />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="settings-group">
              <Row
                title={t("reduceMotion")}
                hint={systemReduced ? t("reducedSystem") : t("reducedHint")}
              >
                <Switch
                  accessibilityLabel={t("reduceMotion")}
                  value={workspace.state.reduceMotion || systemReduced}
                  disabled={systemReduced}
                  onValueChange={(value) =>
                    workspace.setState((s) => ({ ...s, reduceMotion: value }))
                  }
                  trackColor={switchColors}
                  thumbColor={
                    workspace.state.reduceMotion || systemReduced
                      ? colors.primaryText
                      : colors.primary
                  }
                />
              </Row>
            </div>
            <AppearanceSettings appearance={appearance} />
          </SettingsPage>

          <SettingsPage id="models" active={section}>
            <header className="settings-section-head">
              <h2 id="settings-models-title">{t("models")}</h2>
              <p>{t("modelsHint")}</p>
            </header>
            <div
              className="settings-group settings-choices"
              role="radiogroup"
              aria-label={t("defaultProvider")}
            >
              {providers.map(({ id, title, hint }) => {
                const selected = workspace.state.provider === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={workspace.busy}
                    className={`settings-row settings-choice${selected ? " selected" : ""}`}
                    onClick={() =>
                      workspace.setState((s) => ({
                        ...s,
                        provider: id,
                        endpoint:
                          id === "offline"
                            ? s.endpoint
                            : s.endpoint || "http://127.0.0.1:4311",
                      }))
                    }
                  >
                    <span className="settings-radio" aria-hidden="true" />
                    <span className="settings-row-copy">
                      <strong>{t(title)}</strong>
                      <span>{t(hint)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="settings-group">
              <Row
                title={t("codexAccount")}
                hint={
                  <>
                    <span className={`settings-state ${codex.state}`}>
                      {codexLabel}
                    </span>
                    {codex.state === "error" ? ` · ${codex.message}` : ""}
                  </>
                }
              >
                <CodexLoginButton auth={codexAuth} compact={false} />
              </Row>
              <Row title={t("defaultCodex")} hint={t("defaultCodexHint")}>
                <code className="settings-value">{codex.model}</code>
              </Row>
            </div>
            <ModelServiceSettings
              endpoint={workspace.state.endpoint || "http://127.0.0.1:4311"}
              onUse={(provider) =>
                workspace.setState((s) => ({
                  ...s,
                  provider,
                  endpoint: s.endpoint || "http://127.0.0.1:4311",
                }))
              }
            />
          </SettingsPage>

          <SettingsPage id="connection" active={section}>
            <header className="settings-section-head">
              <h2 id="settings-connection-title">{t("connection")}</h2>
              <p>{t("connectionHint")}</p>
            </header>
            <div className="settings-group">
              <div className="settings-row settings-row-stack">
                <label
                  className="settings-row-copy"
                  htmlFor="settings-endpoint"
                >
                  <strong>{t("serviceAddress")}</strong>
                  <span>
                    <code>
                      {t("currentAddress", {
                        address:
                          workspace.state.endpoint || "http://127.0.0.1:4311",
                      })}
                    </code>
                  </span>
                </label>
                <form
                  className="settings-endpoint"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect();
                  }}
                >
                  <input
                    id="settings-endpoint"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="http://192.168.1.8:4311"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    inputMode="url"
                  />
                  <button
                    type="submit"
                    className="tool-button"
                    disabled={checking || workspace.busy}
                  >
                    <Wifi size={14} />
                    {checking ? t("connecting") : t("connect")}
                  </button>
                </form>
                {connection ? (
                  <p
                    className={`settings-feedback ${connection.tone}`}
                    aria-live="polite"
                  >
                    {t(connection.text)}
                  </p>
                ) : null}
              </div>
              {workspace.state.provider !== "offline" ? (
                <Row title={t("disconnect")} hint={t("disconnectHint")}>
                  <button
                    type="button"
                    className="tool-button"
                    disabled={workspace.busy}
                    onClick={() => {
                      workspace.setState((s) => ({
                        ...s,
                        provider: "offline",
                      }));
                      setConnection({ tone: "info", text: "disconnected" });
                    }}
                  >
                    <Radio size={14} />
                    {t("useDemo")}
                  </button>
                </Row>
              ) : null}
            </div>
          </SettingsPage>

          <SettingsPage id="features" active={section}>
            <header className="settings-section-head">
              <h2 id="settings-features-title">{t("features")}</h2>
              <p>{t("featuresHint")}</p>
            </header>
            <IntegrationSettingsPanel
              key={codexAuth.endpoint}
              endpoint={codexAuth.endpoint}
            />
          </SettingsPage>

          <SettingsPage id="plugins" active={section}>
            <header className="settings-section-head">
              <h2 id="settings-plugins-title">{t("plugins")}</h2>
              <p>{t("pluginsHint")}</p>
            </header>
            <PluginList
              endpoint={workspace.state.endpoint || "http://127.0.0.1:4311"}
              settingsPages={pluginSettingsPages}
              onOpenSettings={onOpenPluginSettings}
            />
            <h3 className="settings-subhead">{t("pluginDirectories")}</h3>
            <PluginDirectorySettings
              endpoint={workspace.state.endpoint || "http://127.0.0.1:4311"}
            />
            <PluginMarket
              key={codexAuth.endpoint}
              endpoint={codexAuth.endpoint}
            />
          </SettingsPage>

          <SettingsPage id="records" active={section}>
            <header className="settings-section-head">
              <h2 id="settings-records-title">{t("records")}</h2>
              <p>{t("recordsHint")}</p>
            </header>
            <div className="settings-group">
              <button
                type="button"
                className="settings-row settings-row-button"
                onClick={onHistory}
              >
                <span className="settings-row-copy">
                  <strong>{t("history")}</strong>
                  <span>{t("historyHint")}</span>
                </span>
                <ChevronRight size={16} className="settings-chevron" />
              </button>
              <button
                type="button"
                className="settings-row settings-row-button"
                onClick={onArchived}
              >
                <span className="settings-row-copy">
                  <strong>{t("archived")}</strong>
                  <span>{t("archivedHint")}</span>
                </span>
                <Archive size={16} className="settings-chevron" />
              </button>
            </div>
          </SettingsPage>

          <SettingsPage id="about" active={section}>
            <header className="settings-section-head">
              <h2 id="settings-about-title">{t("about")}</h2>
            </header>
            <div className="settings-group">
              <Row title="Aura" hint={t("tagline")}>
                <code className="settings-value">v0.1.0</code>
              </Row>
              <Row title={t("localData")} hint={t("localDataHint")} />
            </div>
          </SettingsPage>
        </div>
      </div>
    </div>
  );
}
