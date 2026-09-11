import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  useColorScheme,
  useWindowDimensions,
} from "@aura/ui/web";
import {
  Clock3,
  Grid2X2,
  GitBranch,
  MessageCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import { AuraMark, ThemeContext } from "@aura/ui/components";
import { palettes } from "@aura/ui/theme";
import { useWorkspace } from "./useWorkspace";
import { useCodexAuth } from "./useCodexAuth";
import { CodexLoginButton } from "./CodexLoginButton";
import { HomeScreen, HistoryScreen } from "./screens/Home";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";
import { FlowStudio } from "./screens/FlowStudio";
import { flowContext, useFlowDraft } from "./flowDraft";
import type { Tab } from "./types";

const tabs = [
  { id: "flows", label: "Flow 工作台", icon: GitBranch },
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "home", label: "概览", icon: Grid2X2 },
  { id: "history", label: "全部记录", icon: Clock3 },
] as const;

export default function App() {
  const workspace = useWorkspace();
  const codexAuth = useCodexAuth(workspace);
  const flowDraft = useFlowDraft();
  const [tab, setTab] = useState<Tab>("flows");
  const [systemReduced, setSystemReduced] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const systemTheme = useColorScheme();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const split = width >= 1180;
  const dark =
    workspace.state.theme === "system"
      ? systemTheme !== "light"
      : workspace.state.theme === "dark";
  const colors = dark ? palettes.dark : palettes.light;
  const reduced = systemReduced || workspace.state.reduceMotion;
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.style.backgroundColor = colors.background;
    document.body.style.backgroundColor = colors.background;
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.title = "Aura · Flow 工作台";
  }, [colors.background, dark]);
  useEffect(() => {
    if (!wide && sidebarOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [wide, sidebarOpen]);

  const navigate = (next: Tab) => {
    setTab(next);
    setSidebarOpen(false);
  };
  const start = (prompt?: string) => {
    workspace.newChat();
    if (tab !== "flows") setTab("chat");
    setAssistantOpen(true);
    setSidebarOpen(false);
    if (prompt) void workspace.send(prompt);
  };
  const open = (id: string) => {
    workspace.openChat(id);
    if (tab !== "flows") setTab("chat");
    setAssistantOpen(true);
    setSidebarOpen(false);
  };
  const visibleSessions = workspace.state.sessions.filter(
    (session) =>
      (!onlyRunning || workspace.runningIds.includes(session.id)) &&
      `${session.title} ${session.messages.at(-1)?.text ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const sidebar = (
    <aside className="workspace-sidebar" aria-label="工作区与会话">
      <div className="sidebar-brand">
        <AuraMark size={27} />
        <strong>aura</strong>
        <span className="brand-tag">WORKSPACE</span>
        <button
          className="icon-control sidebar-toggle"
          aria-label={wide ? "收起侧栏" : "关闭会话列表"}
          onClick={() => (wide ? setCollapsed(true) : setSidebarOpen(false))}
        >
          {wide ? <PanelLeftClose size={17} /> : <X size={17} />}
        </button>
      </div>
      <button className="new-session" onClick={() => start()}>
        <Plus size={16} />
        新建会话
      </button>
      <nav className="workspace-nav" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <Icon size={16} />
            {label}
            {id === "flows" ? <span className="nav-meta">BUILD</span> : null}
          </button>
        ))}
      </nav>
      <div className="session-heading">
        <span>会话</span>
        <span className="count">{workspace.state.sessions.length}</span>
        <button
          className="text-control"
          aria-pressed={onlyRunning}
          onClick={() => setOnlyRunning(!onlyRunning)}
        >
          {onlyRunning ? "显示全部" : "进行中"}
          {workspace.runningIds.length ? ` ${workspace.runningIds.length}` : ""}
        </button>
      </div>
      <label className="session-search">
        <Search size={14} />
        <input
          aria-label="搜索会话"
          placeholder="搜索会话…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            className="icon-control"
            aria-label="清空搜索"
            onClick={() => setQuery("")}
          >
            <X size={13} />
          </button>
        ) : null}
      </label>
      <div className="session-list">
        {visibleSessions.length ? (
          visibleSessions.map((session, index) => {
            const running = workspace.runningIds.includes(session.id);
            const today =
              new Date(session.updatedAt).toDateString() ===
              new Date().toDateString();
            const previousToday =
              index > 0 &&
              new Date(visibleSessions[index - 1].updatedAt).toDateString() ===
                new Date().toDateString();
            return (
              <React.Fragment key={session.id}>
                {index === 0 || today !== previousToday ? (
                  <div className="session-group">{today ? "今天" : "更早"}</div>
                ) : null}
                <button
                  className={`session-item${workspace.active?.id === session.id ? " selected" : ""}`}
                  aria-current={
                    workspace.active?.id === session.id ? "true" : undefined
                  }
                  aria-label={`打开会话：${session.title}`}
                  onClick={() => open(session.id)}
                >
                  <span
                    className={`session-status${running ? " running" : session.messages.at(-1)?.status === "error" ? " failed" : ""}`}
                  />
                  <span className="session-copy">
                    <span className="session-name">{session.title}</span>
                    <span className="session-preview">
                      {running
                        ? "正在生成回复…"
                        : session.messages.at(-1)?.text || "暂无消息"}
                    </span>
                  </span>
                  <span className="session-time">
                    {new Date(session.updatedAt).toLocaleDateString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                    })}
                  </span>
                </button>
              </React.Fragment>
            );
          })
        ) : (
          <div className="sidebar-empty">
            {query || onlyRunning
              ? "没有匹配的会话"
              : "从一段对话开始。\n生成过程和历史会话会留在这里。"}
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <button
          className={tab === "settings" ? "selected" : ""}
          onClick={() => navigate("settings")}
        >
          <SlidersHorizontal size={16} />
          设置
        </button>
        <span>
          本地工作区 <span className="session-status" />
        </span>
      </div>
    </aside>
  );
  const showChat = tab === "chat" || (tab === "flows" && assistantOpen);
  return (
    <ThemeContext.Provider value={{ colors, dark, reduced }}>
      <div
        className="aura-root workbench"
        data-reduced={reduced}
        style={
          Object.fromEntries(
            Object.entries(colors).map(([key, value]) => [`--${key}`, value]),
          ) as React.CSSProperties
        }
      >
        {!workspace.ready ? (
          <div className="workspace-loading">
            <ActivityIndicator color={colors.accent} />
            正在打开工作台
          </div>
        ) : (
          <>
            {wide && !collapsed ? sidebar : null}
            {!wide ? (
              <dialog
                className="sidebar-dialog"
                ref={dialog}
                onCancel={() => setSidebarOpen(false)}
                onClick={(event) => {
                  if (event.target === event.currentTarget)
                    setSidebarOpen(false);
                }}
              >
                {sidebar}
              </dialog>
            ) : null}
            <main className="workspace-main">
              <header className="workspace-header">
                {collapsed || !wide ? (
                  <button
                    className="icon-control"
                    aria-label="展开会话列表"
                    onClick={() =>
                      wide ? setCollapsed(false) : setSidebarOpen(true)
                    }
                  >
                    <PanelLeftOpen size={18} />
                  </button>
                ) : null}
                <div className="workspace-breadcrumb">
                  <span>工作区</span>
                  <span>/</span>
                  <strong>
                    {tab === "flows"
                      ? "Flow 工作台"
                      : tab === "chat"
                        ? "对话"
                        : tab === "home"
                          ? "概览"
                          : tab === "history"
                            ? "全部记录"
                            : "设置"}
                  </strong>
                </div>
                <div className="header-actions">
                  {tab === "flows" ? (
                    <button
                      className={`tool-button${assistantOpen ? " active" : ""}`}
                      aria-pressed={assistantOpen}
                      onClick={() => setAssistantOpen(!assistantOpen)}
                    >
                      {assistantOpen ? (
                        <PanelRightClose size={15} />
                      ) : (
                        <PanelRightOpen size={15} />
                      )}
                      <span>生成助手</span>
                    </button>
                  ) : null}
                  <CodexLoginButton auth={codexAuth} compact={!wide} />
                  <button
                    className="icon-control"
                    aria-label={dark ? "切换到浅色主题" : "切换到深色主题"}
                    onClick={() =>
                      workspace.setState((s) => ({
                        ...s,
                        theme: dark ? "light" : "dark",
                      }))
                    }
                  >
                    {dark ? <Sun size={17} /> : <Moon size={17} />}
                  </button>
                </div>
              </header>
              {workspace.saveError ? (
                <div className="workspace-notice" role="alert">
                  {workspace.saveError}
                </div>
              ) : null}
              <div
                className={`workspace-deck${tab === "flows" && showChat && split ? " split" : ""}`}
                hidden={tab !== "flows" && tab !== "chat"}
              >
                <div
                  className="flow-area"
                  hidden={tab !== "flows" || (!split && showChat)}
                >
                  <FlowStudio
                    endpoint={codexAuth.endpoint}
                    draft={flowDraft}
                    editorRevision={editorRevision}
                    onAsk={() => {
                      setAssistantOpen(true);
                      workspace.setDraft(
                        "帮我完善当前 Flow，检查步骤拆分、输入输出与异常处理。",
                      );
                    }}
                  />
                </div>
                <div
                  className={`assistant-area${tab === "chat" ? " standalone" : ""}`}
                  hidden={!showChat}
                >
                  {tab === "flows" ? (
                    <div className="assistant-heading">
                      <span>
                        <MessageCircle size={15} />
                        生成助手
                      </span>
                      <div>
                        <button
                          className="icon-control"
                          aria-label="新建助手会话"
                          onClick={() => start()}
                        >
                          <Plus size={15} />
                        </button>
                        <button
                          className="icon-control"
                          aria-label="返回 Flow 编辑器"
                          onClick={() => setAssistantOpen(false)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <ChatScreen
                    workspace={workspace}
                    flowMode={tab === "flows"}
                    context={
                      tab === "flows" ? flowContext(flowDraft.code) : undefined
                    }
                    onApplyFlow={(code) => {
                      flowDraft.update(code);
                      setEditorRevision((value) => value + 1);
                      if (!split) setAssistantOpen(false);
                    }}
                  />
                </div>
              </div>
              {tab === "home" ? (
                <HomeScreen workspace={workspace} start={start} open={open} />
              ) : null}
              {tab === "history" ? (
                <HistoryScreen
                  workspace={workspace}
                  start={start}
                  open={open}
                />
              ) : null}
              {tab === "settings" ? (
                <SettingsScreen
                  workspace={workspace}
                  systemReduced={systemReduced}
                />
              ) : null}
              <footer className="workspace-status">
                <span>
                  <span
                    className={`session-status${workspace.runningIds.length ? " running" : ""}`}
                  />
                  {workspace.runningIds.length
                    ? `${workspace.runningIds.length} 个会话生成中`
                    : "工作区就绪"}
                </span>
                <span>
                  {flowDraft.saveError ? "本地草稿未保存" : "本地草稿已保存"}
                </span>
              </footer>
            </main>
          </>
        )}
      </div>
    </ThemeContext.Provider>
  );
}
