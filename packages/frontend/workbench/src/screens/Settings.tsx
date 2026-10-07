import React, { useEffect, useRef, useState } from "react";
import { Switch } from "@aura/ui/web";
import {
  Check,
  ChevronRight,
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
import { palettes } from "@aura/ui/theme";
import { validateEndpoint } from "@aura/core";
import type { ThemeMode, Workspace } from "@aura/core/types";
import type { WorkspaceController } from "../useWorkspace";
import type { CodexAuthController } from "../useCodexAuth";
import { CodexLoginButton } from "../CodexLoginButton";
import { PluginDirectorySettings } from "./PluginDirectorySettings.tsx";
import { ModelServiceSettings } from "./ModelServiceSettings.tsx";
import "./settings.css";

const sections = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "models", label: "模型与账号", icon: Sparkles },
  { id: "connection", label: "连接", icon: Wifi },
  { id: "plugins", label: "插件", icon: PlugZap },
  { id: "about", label: "关于", icon: Info },
] as const;
type SectionId = (typeof sections)[number]["id"];

const themes: Array<{
  id: ThemeMode;
  title: string;
  hint: string;
  icon: typeof Moon;
}> = [
  { id: "dark", title: "夜航", hint: "深色", icon: Moon },
  { id: "light", title: "晨雾", hint: "浅色", icon: Sun },
  { id: "system", title: "跟随系统", hint: "自动切换", icon: Monitor },
];

const providers: Array<{
  id: Workspace["provider"];
  title: string;
  hint: string;
}> = [
  { id: "offline", title: "本地演示", hint: "无需联网，规则生成回复" },
  { id: "dsh", title: "DSH 演示", hint: "经工作台服务，可调用工作流" },
  { id: "codex", title: "Codex 订阅", hint: "真实模型，需要登录 Codex" },
  {
    id: "lumina",
    title: "Lumina",
    hint: "Lumina 网关，多家模型供应商，需要 API Key",
  },
  {
    id: "custom",
    title: "自定义 API",
    hint: "OpenAI 或 Anthropic 兼容的自建服务",
  },
];

/** Miniature window drawn from one palette, so the choice previews itself. */
function ThemePreview({ mode }: { mode: "dark" | "light" }) {
  const p = palettes[mode];
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

export function SettingsScreen({
  workspace,
  codexAuth,
  systemReduced,
}: {
  workspace: WorkspaceController;
  codexAuth: CodexAuthController;
  systemReduced: boolean;
}) {
  const { colors } = useTheme();
  const [address, setAddress] = useState(
    workspace.state.endpoint || "http://127.0.0.1:4311",
  );
  const [connection, setConnection] = useState<{
    tone: "ok" | "error" | "info";
    text: string;
  }>();
  const [checking, setChecking] = useState(false);
  const [lab, setLab] = useState(false);
  const [active, setActive] = useState<SectionId>("appearance");
  const scroller = useRef<HTMLDivElement>(null);

  // The active section is the last one whose top has passed the reading line;
  // at the very bottom the final section wins even when it is short.
  const jumping = useRef<SectionId | null>(null);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const update = () => {
      if (jumping.current) return;
      const line = root.getBoundingClientRect().top + 48;
      let current: SectionId = sections[0].id;
      for (const { id } of sections) {
        const node = root.querySelector(`#settings-${id}`);
        if (node && node.getBoundingClientRect().top <= line) current = id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2)
        current = sections[sections.length - 1].id;
      setActive(current);
    };
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, []);

  function jump(id: SectionId) {
    setActive(id);
    // Keep the clicked item highlighted while smooth scrolling passes others.
    jumping.current = id;
    window.setTimeout(() => {
      if (jumping.current === id) jumping.current = null;
    }, 700);
    scroller.current
      ?.querySelector(`#settings-${id}`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  async function connect() {
    const endpoint = validateEndpoint(address);
    if (!endpoint) {
      setConnection({
        tone: "error",
        text: "请输入完整服务地址，例如 http://192.168.1.8:4311",
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
        throw new Error("此地址没有运行 Aura 对话服务。");
      workspace.setState((s) => ({
        ...s,
        endpoint,
        provider: s.provider === "offline" ? "dsh" : s.provider,
      }));
      setConnection({ tone: "ok", text: "已连接工作台服务。" });
    } catch (e) {
      setConnection({
        tone: "error",
        text:
          e instanceof Error && e.name !== "AbortError"
            ? "连接失败。请确认地址、网络与工作台服务。"
            : "连接超时，请检查工作台地址。",
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
      ? "已登录"
      : codex.state === "pending"
        ? "登录中"
        : codex.state === "error"
          ? "登录失败"
          : "未登录";

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="设置分类">
        <h1>设置</h1>
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={active === id ? "selected" : ""}
            aria-current={active === id ? "true" : undefined}
            onClick={() => jump(id)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-scroll" ref={scroller}>
        <div className="settings-content">
          <section
            id="settings-appearance"
            aria-labelledby="settings-appearance-title"
          >
            <header className="settings-section-head">
              <h2 id="settings-appearance-title">外观</h2>
              <p>主题和动效只保存在这台设备上。</p>
            </header>
            <div
              className="settings-themes"
              role="radiogroup"
              aria-label="界面主题"
            >
              {themes.map(({ id, title, hint, icon: Icon }) => {
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
                        <ThemePreview mode="dark" />
                        <ThemePreview mode="light" />
                      </span>
                    ) : (
                      <ThemePreview mode={id} />
                    )}
                    <span className="settings-theme-label">
                      <Icon size={14} />
                      <strong>{title}</strong>
                      <span>{hint}</span>
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
                title="减少动态效果"
                hint={
                  systemReduced
                    ? "已遵循系统的减少动态效果设置"
                    : "关闭轨道旋转与入场过渡，按钮仍保留即时反馈"
                }
              >
                <Switch
                  accessibilityLabel="减少动态效果"
                  value={workspace.state.reduceMotion || systemReduced}
                  disabled={systemReduced}
                  onValueChange={(value) =>
                    workspace.setState((s) => ({ ...s, reduceMotion: value }))
                  }
                  trackColor={switchColors}
                  thumbColor="#FFFFFF"
                />
              </Row>
              <button
                type="button"
                className="settings-row settings-row-button"
                aria-expanded={lab}
                onClick={() => setLab((value) => !value)}
              >
                <span className="settings-row-copy">
                  <strong>主题实验室</strong>
                  <span>查看字体、色板与动效参数</span>
                </span>
                <ChevronRight
                  size={16}
                  className={`settings-chevron${lab ? " open" : ""}`}
                />
              </button>
              {lab ? (
                <div className="settings-lab">
                  <div className="settings-lab-type">
                    <span>Aa. aura</span>
                    <p>
                      Manrope · 界面与标题
                      <br />
                      IBM Plex Mono · 数字与技术标签
                      <br />
                      中文 · 设备原生中文字体
                    </p>
                  </div>
                  <div className="settings-swatches">
                    {(
                      [
                        "background",
                        "surface",
                        "soft",
                        "accent",
                        "primary",
                      ] as const
                    ).map((key) => (
                      <div key={key}>
                        <span style={{ background: colors[key] }} />
                        <code>{key}</code>
                      </div>
                    ))}
                  </div>
                  <code className="settings-lab-motion">
                    PRESS 110ms · REVEAL 420ms · ORBIT 24s
                  </code>
                </div>
              ) : null}
            </div>
          </section>

          <section id="settings-models" aria-labelledby="settings-models-title">
            <header className="settings-section-head">
              <h2 id="settings-models-title">模型与账号</h2>
              <p>
                新对话默认使用的回复方式。工作流的运行模式在运行时单独选择。
              </p>
            </header>
            <div
              className="settings-group settings-choices"
              role="radiogroup"
              aria-label="默认对话模型"
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
                      <strong>{title}</strong>
                      <span>{hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="settings-group">
              <Row
                title="Codex 账号"
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
              <Row
                title="默认 Codex 模型"
                hint="后端默认配置；可在每个会话的输入框下单独覆盖模型与思考强度"
              >
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
          </section>

          <section
            id="settings-connection"
            aria-labelledby="settings-connection-title"
          >
            <header className="settings-section-head">
              <h2 id="settings-connection-title">连接</h2>
              <p>
                工作台服务负责对话、工作流和工作台数据。手机连接时请填写电脑的局域网
                IP。
              </p>
            </header>
            <div className="settings-group">
              <div className="settings-row settings-row-stack">
                <label
                  className="settings-row-copy"
                  htmlFor="settings-endpoint"
                >
                  <strong>工作台服务地址</strong>
                  <span>
                    当前：
                    <code>
                      {workspace.state.endpoint || "http://127.0.0.1:4311"}
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
                    {checking ? "正在连接…" : "测试并连接"}
                  </button>
                </form>
                {connection ? (
                  <p
                    className={`settings-feedback ${connection.tone}`}
                    aria-live="polite"
                  >
                    {connection.text}
                  </p>
                ) : null}
              </div>
              {workspace.state.provider !== "offline" ? (
                <Row title="断开工作台" hint="切回本地演示，不影响已保存的会话">
                  <button
                    type="button"
                    className="tool-button"
                    disabled={workspace.busy}
                    onClick={() => {
                      workspace.setState((s) => ({
                        ...s,
                        provider: "offline",
                      }));
                      setConnection({ tone: "info", text: "已切回本地演示。" });
                    }}
                  >
                    <Radio size={14} />
                    使用本地演示
                  </button>
                </Row>
              ) : null}
            </div>
          </section>

          <section
            id="settings-plugins"
            aria-labelledby="settings-plugins-title"
          >
            <header className="settings-section-head">
              <h2 id="settings-plugins-title">插件</h2>
              <p>
                显式接入本机的 Action 与 Flow 目录。插件以完整 Node.js
                权限运行。
              </p>
            </header>
            <PluginDirectorySettings
              endpoint={workspace.state.endpoint || "http://127.0.0.1:4311"}
            />
          </section>

          <section id="settings-about" aria-labelledby="settings-about-title">
            <header className="settings-section-head">
              <h2 id="settings-about-title">关于</h2>
            </header>
            <div className="settings-group">
              <Row title="Aura" hint="专注于日常，也给灵感留白。">
                <code className="settings-value">v0.1.0</code>
              </Row>
              <Row
                title="本地数据"
                hint="会话与偏好保存在本机浏览器存储；模型凭据只保存在后端。"
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
