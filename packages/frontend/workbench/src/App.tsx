import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  useColorScheme,
  useWindowDimensions,
} from "@aura/ui/web";
import {
  MessageCircle,
  Moon,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Sun,
  X,
} from "lucide-react";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import { ThemeContext } from "@aura/ui/components";
import { palettes } from "@aura/ui/theme";
import { useWorkspace } from "./useWorkspace";
import { useCodexAuth } from "./useCodexAuth";
import { CodexLoginButton } from "./CodexLoginButton";
import { HomeScreen, HistoryScreen } from "./screens/Home";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";
import { SiteScreen } from "./screens/Site";
import { Workflows } from "./screens/Workflows";
import { useFlowCatalog } from "./flowCatalog";
import { flowContext, useFlowDraft } from "./flowDraft";
import type { Tab } from "./types";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

const WorkflowChat = React.lazy(() =>
  import("./screens/WorkflowChat").then((module) => ({
    default: module.WorkflowChat,
  })),
);

export default function App() {
  const workspace = useWorkspace();
  const codexAuth = useCodexAuth(workspace);
  const flowDraft = useFlowDraft();
  const catalogState = useFlowCatalog(codexAuth.endpoint);
  const [workflowDetail, setWorkflowDetail] = useState(false);
  const [videoDirty, setVideoDirty] = useState(false);
  const canLeaveVideo = () =>
    !videoDirty || window.confirm("视频剧本有未保存修改，确认离开？");
  const [workflowBrowseRevision, setWorkflowBrowseRevision] = useState(0);
  const [tab, setTab] = useState<Tab>("flows");
  const [systemReduced, setSystemReduced] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
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
    document.title = "Aura · 工作流";
  }, [colors.background, dark]);
  useEffect(() => {
    if (!wide && sidebarOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [wide, sidebarOpen]);

  const navigate = (next: Tab) => {
    if (!canLeaveVideo()) return;
    setTab(next);
    if (next === "flows") {
      setWorkflowBrowseRevision((value) => value + 1);
      setAssistantOpen(false);
    }
    setSidebarOpen(false);
  };
  const start = (prompt?: string) => {
    if (!canLeaveVideo()) return;
    workspace.newChat();
    setTab("chat");
    setAssistantOpen(false);
    setSidebarOpen(false);
    if (prompt) void workspace.send(prompt);
  };
  const open = (id: string) => {
    if (!canLeaveVideo()) return;
    workspace.openChat(id);
    setTab("chat");
    setAssistantOpen(false);
    setSidebarOpen(false);
  };
  const sidebar = (
    <WorkspaceSidebar
      workspace={workspace}
      tab={tab}
      wide={wide}
      onCollapse={() => (wide ? setCollapsed(true) : setSidebarOpen(false))}
      navigate={navigate}
      start={() => start()}
      open={open}
    />
  );
  const showChat =
    tab === "chat" ||
    (tab === "flows" &&
      workflowDetail &&
      assistantOpen &&
      !workspace.active?.workflow);
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
                      ? "工作流"
                      : tab === "chat"
                        ? "对话"
                        : tab === "home"
                          ? "概览"
                          : tab === "history"
                            ? "全部记录"
                            : tab === "site"
                              ? "Site"
                              : "设置"}
                  </strong>
                </div>
                <div className="header-actions">
                  {tab === "flows" && workflowDetail ? (
                    <button
                      className={`tool-button${assistantOpen ? " active" : ""}`}
                      aria-pressed={assistantOpen}
                      onClick={() => {
                        if (workspace.active?.workflow) workspace.newChat();
                        setAssistantOpen(!assistantOpen);
                      }}
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
                  <Workflows
                    browseRevision={workflowBrowseRevision}
                    endpoint={codexAuth.endpoint}
                    catalogState={catalogState}
                    onDetailChange={setWorkflowDetail}
                    onDirtyChange={setVideoDirty}
                    onRun={(flow) => {
                      workspace.newWorkflowChat(flow, codexAuth.endpoint);
                      setTab("chat");
                      setAssistantOpen(false);
                    }}
                    draft={flowDraft}
                    editorRevision={editorRevision}
                    onAsk={() => {
                      if (workspace.active?.workflow) workspace.newChat();
                      setAssistantOpen(true);
                      workspace.setDraft(
                        "帮我完善当前工作流，检查步骤拆分、输入输出与异常处理。",
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
                          onClick={() => workspace.newChat()}
                        >
                          <Plus size={15} />
                        </button>
                        <button
                          className="icon-control"
                          aria-label="返回工作流编辑器"
                          onClick={() => setAssistantOpen(false)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {workspace.active?.workflow ? (
                    <React.Suspense
                      fallback={
                        <div className="workspace-loading">
                          正在打开执行记录…
                        </div>
                      }
                    >
                      <WorkflowChat
                        key={workspace.active.id}
                        workspace={workspace}
                        flow={catalogState.catalog?.flows.find(
                          (flow) =>
                            flow.id === workspace.active?.workflow?.id &&
                            workspace.active.workflow.endpoint ===
                              codexAuth.endpoint,
                        )}
                      />
                    </React.Suspense>
                  ) : (
                    <ChatScreen
                      workspace={workspace}
                      flowMode={tab === "flows"}
                      context={
                        tab === "flows"
                          ? flowContext(flowDraft.code)
                          : undefined
                      }
                      onApplyFlow={(code) => {
                        setTab("flows");
                        flowDraft.update(code);
                        setEditorRevision((value) => value + 1);
                        if (!split) setAssistantOpen(false);
                      }}
                    />
                  )}
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
              {tab === "site" ? <SiteScreen /> : null}
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
