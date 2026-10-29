import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  useColorScheme,
  useWindowDimensions,
} from "@aura/ui/web";
import {
  MessageCircle,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import { FlowIcon } from "./FlowIcon";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import "./shell.css";
import "./workflow-output.css";
import { ThemeContext } from "@aura/ui/components";
import { palettes } from "@aura/ui/theme";
import { useWorkspace } from "./useWorkspace";
import { useCodexAuth } from "./useCodexAuth";
import { CodexLoginButton } from "./CodexLoginButton";
import { ModelServiceBadge } from "./ModelServiceBadge";
import { HistoryScreen } from "./screens/Home";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";
import { Workflows } from "./screens/Workflows";
import { useFlowCatalog } from "./flowCatalog";
import { flowContext, useFlowDraft } from "./flowDraft";
import type { StudioTab, Tab } from "./types";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceMenubar } from "./WorkspaceMenubar";
import { ResizableSidebar, DEFAULT_SIDEBAR_WIDTH } from "./ResizableSidebar";
import { SessionActions, type SessionDialogRequest } from "./SessionActions";
import { SessionDialog } from "./SessionDialog";
import { SessionStatus } from "./SessionStatus";
import { ToastProvider } from "./toast";
import { sidebarSessionStatus, sidebarSessionTitle } from "./sidebarSessions";
import { platform } from "./platform";
import { useCodingProjects } from "./features/coding/useCodingProjects";
import { isActiveStatus } from "./features/coding/conversationStatus";
import type { CodingHandoff } from "./features/coding/CodingStudio";
import { usePluginPages } from "./usePluginPages";
import { isPluginTab } from "./pluginPages";
import { PluginPageBoundary } from "./PluginPageBoundary";
import { migratedStudioTab } from "./studio-navigation.ts";
import "./workspace-chrome.css";

const CodingStudio = React.lazy(() =>
  import("./features/coding/CodingStudio").then((module) => ({
    default: module.CodingStudio,
  })),
);
const tabTitles: Record<Tab, string> = {
  chat: "对话",
  flows: "工作流",
  "studio:content": "自媒体内容",
  "studio:video": "视频项目",
  "studio:research": "选题库",
  "studio:coding": "工作空间",
  history: "全部记录",
  site: "Site",
  settings: "设置",
};
const isStudio = (tab: Tab): tab is StudioTab | `plugin:${string}` =>
  tab.startsWith("studio:") || isPluginTab(tab);

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
  const codingWorkspaces = useCodingProjects(
    codexAuth.endpoint,
    workspace.ready && workspace.state.provider !== "offline",
  );
  const pluginPages = usePluginPages(codexAuth.endpoint, workspace.ready);
  const runningCount = new Set([
    ...workspace.runningIds,
    ...Object.entries(codingWorkspaces.statuses)
      .filter(([, status]) => isActiveStatus(status))
      .map(([id]) => id),
  ]).size;
  const [workflowDetail, setWorkflowDetail] = useState(false);
  const [codingHandoff, setCodingHandoff] = useState<CodingHandoff>();
  const takeHandoff = useCallback(() => setCodingHandoff(undefined), []);
  const [studioDirty, setStudioDirty] = useState(false);
  const canLeaveStudio = () =>
    !studioDirty || window.confirm("工作台有未保存修改，确认离开？");
  const [workflowBrowseRevision, setWorkflowBrowseRevision] = useState(0);
  const [tab, setTab] = useState<Tab>("chat");
  const [showArchived, setShowArchived] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogRequest>();
  const navigation = useRef<Array<{ tab: Tab; sessionId: string | null }>>([
    { tab: "chat", sessionId: null },
  ]);
  const [navigationIndex, setNavigationIndex] = useState(0);
  const [systemReduced, setSystemReduced] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const systemTheme = useColorScheme();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const sidebarWidth = Math.max(
    240,
    Math.min(
      480,
      width - 560,
      workspace.state.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
    ),
  );
  const split = width - (wide && !collapsed ? sidebarWidth : 0) >= 930;
  const dark =
    workspace.state.theme === "system"
      ? systemTheme !== "light"
      : workspace.state.theme === "dark";
  const colors = dark ? palettes.dark : palettes.light;
  const reduced = systemReduced || workspace.state.reduceMotion;
  const pluginStudio = isPluginTab(tab)
    ? pluginPages.studios.find((studio) => studio.id === tab)
    : undefined;
  const pagePluginId = pluginStudio?.pluginId;
  const createPageInvoke = pluginPages.invoke;
  const invokePluginPage = useMemo(
    () =>
      pagePluginId
        ? createPageInvoke(codexAuth.endpoint, pagePluginId)
        : undefined,
    [codexAuth.endpoint, pagePluginId, createPageInvoke],
  );
  const currentTitle =
    tab === "chat" && workspace.active
      ? sidebarSessionTitle(workspace.active)
      : (pluginStudio?.title ??
        (tab in tabTitles
          ? tabTitles[tab as keyof typeof tabTitles]
          : "工作台"));
  const activeConversation = codingWorkspaces.selectedId
    ? codingWorkspaces.conversations[codingWorkspaces.selectedId]?.find(
        (item) => item.id === codingWorkspaces.conversationId,
      )
    : undefined;
  const documentTitle = `Aura · ${currentTitle}`;
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
    document.title = documentTitle;
  }, [colors.background, dark, documentTitle]);
  useEffect(() => {
    if (tab === "chat" && navigation.current[navigationIndex]?.tab === "chat")
      navigation.current[navigationIndex].sessionId =
        workspace.active?.id ?? null;
  }, [tab, navigationIndex, workspace.active?.id]);
  useEffect(() => {
    void window.auraHost?.chrome?.setTheme(dark).catch(() => {});
  }, [dark]);
  useEffect(() => {
    if (!wide && sidebarOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [wide, sidebarOpen]);

  const remember = (next: Tab, sessionId = workspace.active?.id ?? null) => {
    const current = navigation.current[navigationIndex];
    if (current.tab === next && current.sessionId === sessionId) return;
    navigation.current = [
      ...navigation.current.slice(0, navigationIndex + 1),
      { tab: next, sessionId },
    ].slice(-80);
    setNavigationIndex(navigation.current.length - 1);
  };
  const travel = (direction: -1 | 1) => {
    const index = navigationIndex + direction;
    const next = navigation.current[index];
    if (!next || !canLeaveStudio()) return;
    setStudioDirty(false);
    setNavigationIndex(index);
    setTab(next.tab);
    if (
      next.sessionId &&
      workspace.state.sessions.some((session) => session.id === next.sessionId)
    )
      workspace.openChat(next.sessionId);
    else workspace.newChat();
    setAssistantOpen(false);
    setSidebarOpen(false);
    if (next.tab === "flows") setWorkflowBrowseRevision((value) => value + 1);
  };
  const toggleSidebar = () =>
    wide ? setCollapsed((value) => !value) : setSidebarOpen((value) => !value);
  const toggleTheme = () =>
    workspace.setState((s) => ({ ...s, theme: dark ? "light" : "dark" }));
  const navigate = (requested: Tab) => {
    const next = migratedStudioTab(requested);
    if (next === tab && isStudio(next)) return;
    if (!canLeaveStudio()) return;
    setStudioDirty(false);
    remember(next);
    setTab(next);
    if (next === "flows") {
      setWorkflowBrowseRevision((value) => value + 1);
      setAssistantOpen(false);
    }
    setSidebarOpen(false);
  };
  const start = (prompt?: string) => {
    if (!canLeaveStudio()) return;
    setStudioDirty(false);
    workspace.newChat();
    codingWorkspaces.newChat();
    setCodingHandoff(prompt ? { id: crypto.randomUUID(), prompt } : undefined);
    remember("chat", null);
    setTab("chat");
    setAssistantOpen(false);
    setSidebarOpen(false);
    if (prompt && workspace.state.provider === "offline")
      void workspace.send(prompt);
  };
  const open = (id: string) => {
    if (!canLeaveStudio()) return;
    setStudioDirty(false);
    workspace.openChat(id);
    const imported = Object.values(codingWorkspaces.conversations)
      .flat()
      .find((item) => item.id === `legacy-${id}`);
    if (imported) {
      codingWorkspaces.open(imported.projectId, imported.id);
      workspace.newChat();
    } else codingWorkspaces.newChat();
    remember("chat", id);
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
      showArchived={showArchived}
      onArchived={setShowArchived}
      onDialog={setSessionDialog}
      endpoint={codexAuth.endpoint}
      codingWorkspaces={codingWorkspaces}
      offline={workspace.state.provider === "offline"}
      pluginStudios={pluginPages.studios}
    />
  );
  const showChat =
    tab === "chat" ||
    tab === "studio:coding" ||
    (tab === "flows" &&
      workflowDetail &&
      assistantOpen &&
      !workspace.active?.workflow);
  return (
    <ThemeContext.Provider value={{ colors, dark, reduced }}>
      <div
        className="aura-root workbench"
        data-reduced={reduced}
        data-platform={platform()}
        style={
          Object.fromEntries(
            Object.entries(colors).map(([key, value]) => [`--${key}`, value]),
          ) as React.CSSProperties
        }
      >
        <ToastProvider>
          {!workspace.ready ? (
            <div className="workspace-loading">
              <ActivityIndicator color={colors.accent} />
              正在打开工作台
            </div>
          ) : (
            <>
              <WorkspaceMenubar
                workspace={workspace}
                dark={dark}
                sidebarVisible={wide ? !collapsed : sidebarOpen}
                canBack={navigationIndex > 0}
                canForward={navigationIndex < navigation.current.length - 1}
                back={() => travel(-1)}
                forward={() => travel(1)}
                toggleSidebar={toggleSidebar}
                toggleTheme={toggleTheme}
                navigate={navigate}
                start={() => start()}
                onDialog={setSessionDialog}
                onArchived={() => {
                  setShowArchived(true);
                  if (wide) setCollapsed(false);
                  else setSidebarOpen(true);
                }}
              />
              <div className="workspace-body">
                {wide && !collapsed ? (
                  <ResizableSidebar
                    width={
                      workspace.state.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH
                    }
                    viewport={width}
                    onResize={(sidebarWidth) =>
                      workspace.setState((s) => ({ ...s, sidebarWidth }))
                    }
                  >
                    {sidebar}
                  </ResizableSidebar>
                ) : null}
                {!wide ? (
                  <dialog
                    className="sidebar-dialog"
                    aria-label="会话列表"
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
                    <div className="workspace-heading">
                      {workspace.active?.workflow && tab === "chat" ? (
                        <FlowIcon size={16} />
                      ) : (
                        <FolderOpen size={16} />
                      )}
                      <strong title={currentTitle}>
                        {tab === "chat"
                          ? workspace.active
                            ? sidebarSessionTitle(workspace.active)
                            : (activeConversation?.title ?? "新对话")
                          : currentTitle}
                      </strong>
                      {tab === "chat" && workspace.active?.archivedAt ? (
                        <span className="header-archived">已归档</span>
                      ) : null}
                    </div>
                    <div className="header-actions">
                      {tab === "chat" && workspace.active ? (
                        <>
                          <SessionStatus
                            status={sidebarSessionStatus(
                              workspace.active,
                              workspace.runningIds.includes(
                                workspace.active.id,
                              ),
                            )}
                            text={wide}
                          />
                          <SessionActions
                            session={workspace.active}
                            workspace={workspace}
                            onDialog={setSessionDialog}
                            className="icon-control header-session-more"
                          />
                          <span className="header-divider" />
                        </>
                      ) : null}
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
                      {workspace.state.provider === "lumina" ||
                      workspace.state.provider === "custom" ? (
                        <ModelServiceBadge
                          endpoint={codexAuth.endpoint}
                          provider={workspace.state.provider}
                          compact={!wide}
                          onOpen={() => navigate("settings")}
                        />
                      ) : (
                        <CodexLoginButton auth={codexAuth} compact={!wide} />
                      )}
                    </div>
                  </header>
                  {workspace.saveError ? (
                    <div className="workspace-notice" role="alert">
                      {workspace.saveError}
                    </div>
                  ) : null}
                  <div
                    className={`workspace-deck${tab === "flows" && showChat && split ? " split" : ""}`}
                    hidden={
                      tab !== "flows" &&
                      tab !== "chat" &&
                      tab !== "studio:coding"
                    }
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
                        onOpenStudio={navigate}
                        onRun={(flow) => {
                          const sessionId = workspace.newWorkflowChat(
                            flow,
                            codexAuth.endpoint,
                          );
                          remember("chat", sessionId);
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
                      {workspace.state.provider !== "offline" ? (
                        <div
                          className="studio-area"
                          style={
                            workspace.active?.workflow && tab === "chat"
                              ? { display: "none" }
                              : undefined
                          }
                        >
                          <React.Suspense
                            fallback={
                              <div className="workspace-loading">
                                正在打开对话…
                              </div>
                            }
                          >
                            <CodingStudio
                              key={codexAuth.endpoint}
                              endpoint={codexAuth.endpoint}
                              provider={workspace.state.provider}
                              workspaces={codingWorkspaces}
                              handoff={codingHandoff}
                              onHandoffTaken={takeHandoff}
                              legacy={
                                tab === "chat" &&
                                workspace.active &&
                                !workspace.active.workflow
                                  ? workspace.active
                                  : undefined
                              }
                              onOpened={() => {
                                workspace.setDraft("");
                                workspace.newChat();
                              }}
                              context={
                                tab === "flows"
                                  ? flowContext(flowDraft.code)
                                  : undefined
                              }
                              initialDraft={
                                tab === "flows" ? workspace.draft : undefined
                              }
                              onApplyFlow={
                                tab === "flows"
                                  ? (code) => {
                                      flowDraft.update(code);
                                      setEditorRevision((value) => value + 1);
                                      if (!split) setAssistantOpen(false);
                                    }
                                  : undefined
                              }
                              flows={catalogState.catalog?.flows}
                              flowsLoading={
                                !catalogState.catalog && !catalogState.error
                              }
                              onRunFlow={(flow) => {
                                const id = workspace.newWorkflowChat(
                                  flow,
                                  codexAuth.endpoint,
                                );
                                remember("chat", id);
                                setTab("chat");
                              }}
                              onProvider={(provider) =>
                                workspace.setState((current) => ({
                                  ...current,
                                  provider,
                                }))
                              }
                              onBack={() => navigate("chat")}
                            />
                          </React.Suspense>
                        </div>
                      ) : null}
                      {workspace.active?.workflow && tab === "chat" ? (
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
                      ) : workspace.state.provider === "offline" ? (
                        <ChatScreen
                          workspace={workspace}
                          context={
                            tab === "flows"
                              ? flowContext(flowDraft.code)
                              : undefined
                          }
                          onApplyFlow={(code) => {
                            remember("flows");
                            setTab("flows");
                            flowDraft.update(code);
                            setEditorRevision((value) => value + 1);
                            if (!split) setAssistantOpen(false);
                          }}
                        />
                      ) : null}
                    </div>
                  </div>
                  {isStudio(tab) && tab !== "studio:coding" ? (
                    <div className="studio-area">
                      <React.Suspense
                        fallback={
                          <div className="workspace-loading">
                            正在打开{currentTitle}…
                          </div>
                        }
                      >
                        {isPluginTab(tab) ? (
                          pluginStudio ? (
                            <PluginPageBoundary
                              key={pluginStudio.id}
                              label={pluginStudio.title}
                              renderPage={() =>
                                pluginStudio.page.definition.render({
                                  endpoint: codexAuth.endpoint,
                                  pluginId: pluginStudio.pluginId,
                                  invoke: invokePluginPage!,
                                  onDirtyChange: setStudioDirty,
                                  onBack: () => navigate("chat"),
                                })
                              }
                            />
                          ) : (
                            <div className="workspace-loading">
                              {pluginPages.failures[0]?.message ??
                                "插件工作台尚未就绪。"}
                            </div>
                          )
                        ) : null}
                      </React.Suspense>
                    </div>
                  ) : null}
                  {tab === "history" ? (
                    <HistoryScreen
                      workspace={workspace}
                      start={start}
                      open={open}
                      onDialog={setSessionDialog}
                      conversations={codingWorkspaces}
                      openConversation={(projectId, id) => {
                        codingWorkspaces.open(projectId, id);
                        workspace.newChat();
                        navigate("studio:coding");
                      }}
                    />
                  ) : null}
                  {tab === "settings" ? (
                    <SettingsScreen
                      workspace={workspace}
                      codexAuth={codexAuth}
                      systemReduced={systemReduced}
                    />
                  ) : null}
                  <footer className="workspace-status">
                    <span>
                      <span
                        className={`session-status${runningCount ? " running" : ""}`}
                      />
                      {runningCount
                        ? `${runningCount} 个会话生成中`
                        : "工作区就绪"}
                    </span>
                    <span>
                      {flowDraft.saveError
                        ? "本地草稿未保存"
                        : "本地草稿已保存"}
                    </span>
                  </footer>
                </main>
              </div>
              {sessionDialog ? (
                <SessionDialog
                  key={`${sessionDialog.sessionId}:${sessionDialog.mode}`}
                  request={sessionDialog}
                  workspace={workspace}
                  onClose={() => setSessionDialog(undefined)}
                />
              ) : null}
            </>
          )}
        </ToastProvider>
      </div>
    </ThemeContext.Provider>
  );
}
