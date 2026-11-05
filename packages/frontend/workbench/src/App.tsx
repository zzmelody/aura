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
import "@aura/ui/icons.css";
import "./styles.css";
import "./shell.css";
import "./workflow-output.css";
import { ThemeContext } from "@aura/ui/components";
import { fonts, palettes } from "@aura/ui/theme";
import { useWorkspace } from "./useWorkspace";
import { IntegrationProvider } from "./integrations.tsx";
import { providerMode } from "@aura/core";
import { useChatModels } from "./useChatModels";
import { useCodexAuth } from "./useCodexAuth";
import { useScheduledConversations } from "./useScheduledConversations";
import { useFlowCatalog } from "./flowCatalog";
import type { FlowConversationRequest } from "./flow-conversation";
import { flowContext, useFlowDraft } from "./flowDraft";
import type { StudioTab, Tab } from "./types";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceMenubar } from "./WorkspaceMenubar";
import { ResizableSidebar, DEFAULT_SIDEBAR_WIDTH } from "./ResizableSidebar";
import { SessionActions, type SessionDialogRequest } from "./SessionActions";
import type { WorkbenchMenuItem } from "./WorkbenchMenu";
import { SessionDialog } from "./SessionDialog";
import { SessionStatus } from "./SessionStatus";
import { ToastProvider } from "./toast";
import { sidebarSessionStatus, sidebarSessionTitle } from "./sidebarSessions";
import { platform } from "./platform";
import { useCodingProjects } from "./features/coding/useCodingProjects";
import type { CodingHandoff } from "./features/coding/CodingStudio";
import { usePluginPages } from "./usePluginPages";
import { isPluginTab } from "./pluginPages";
import { PluginResultsProvider } from "./pluginResults";
import { PluginPageBoundary } from "./PluginPageBoundary";
import "./workspace-chrome.css";
import { StudiosScreen } from "./screens/Studios";
import { Workflows } from "./screens/Workflows";

const HistoryScreen = React.lazy(() =>
  import("./screens/Home").then((module) => ({
    default: module.HistoryScreen,
  })),
);
const loadChatScreen = () =>
  import("./screens/Chat").then((module) => ({ default: module.ChatScreen }));
const ChatScreen = React.lazy(loadChatScreen);
const SettingsScreen = React.lazy(() =>
  import("./screens/Settings").then((module) => ({
    default: module.SettingsScreen,
  })),
);
const AutomationScreen = React.lazy(() =>
  import("./screens/Automation").then((module) => ({
    default: module.AutomationScreen,
  })),
);
const loadCodingStudio = () =>
  import("./features/coding/CodingStudio").then((module) => ({
    default: module.CodingStudio,
  }));
const CodingStudio = React.lazy(loadCodingStudio);
const tabTitles: Record<Tab, string> = {
  chat: "新任务",
  assistant: "Aura",
  flows: "工作流",
  "studio:coding": "工作空间",
  studios: "工作台",
  history: "全部记录",
  automation: "自动化任务",
  settings: "设置",
};
const isStudio = (tab: Tab): tab is StudioTab | `plugin:${string}` =>
  tab.startsWith("studio:") || isPluginTab(tab);

const WorkflowChat = React.lazy(() =>
  import("./screens/WorkflowChat").then((module) => ({
    default: module.WorkflowChat,
  })),
);

export interface WorkbenchReadyState {
  dark: boolean;
  reduced: boolean;
}

interface AppProps {
  onReady?: (state: WorkbenchReadyState) => void;
}

export default function App({ onReady }: AppProps) {
  const workspace = useWorkspace();
  const codexAuth = useCodexAuth(workspace);
  const flowDraft = useFlowDraft();
  const catalogState = useFlowCatalog(codexAuth.endpoint);
  const [tab, setTab] = useState<Tab>("chat");
  const online = workspace.state.provider !== "offline" || tab === "assistant";
  const startupModels = useChatModels(
    codexAuth.endpoint,
    providerMode(workspace.state.provider),
    workspace.ready && online,
  );
  const [readySurface, setReadySurface] = useState<"online" | "offline">();
  const startupSurface = online ? "online" : "offline";
  useEffect(() => {
    if (!workspace.ready || !onReady) return;
    let current = true;
    void (online ? loadCodingStudio : loadChatScreen)().then(
      () => {
        if (current) setReadySurface(startupSurface);
      },
      () => {
        // The lazy boundary reports module errors to the host's startup UI.
      },
    );
    return () => {
      current = false;
    };
  }, [workspace.ready, onReady, online, startupSurface]);
  const codingWorkspaces = useCodingProjects(
    codexAuth.endpoint,
    workspace.ready &&
      (workspace.state.provider !== "offline" || tab === "assistant"),
    Boolean(
      (startupModels.catalog && !startupModels.restored) || startupModels.error,
    ),
  );
  const pluginPages = usePluginPages(codexAuth.endpoint, workspace.ready);
  const [workflowDetail, setWorkflowDetail] = useState(false);
  const [codingHandoff, setCodingHandoff] = useState<CodingHandoff>();
  const [flowRequest, setFlowRequest] = useState<FlowConversationRequest>();
  const takeFlowRequest = useCallback(() => setFlowRequest(undefined), []);
  const [workflowDiscussionId, setWorkflowDiscussionId] = useState<string>();
  const takeHandoff = useCallback(() => setCodingHandoff(undefined), []);
  const [studioDirty, setStudioDirty] = useState(false);
  const canLeaveStudio = () =>
    !studioDirty || window.confirm("工作台有未保存修改，确认离开？");
  const [workflowBrowseRevision, setWorkflowBrowseRevision] = useState(0);
  const [flowsOpened, setFlowsOpened] = useState(false);
  useEffect(() => {
    if (tab === "flows") setFlowsOpened(true);
  }, [tab]);
  const [showArchived, setShowArchived] = useState(false);
  const scheduledIds = useScheduledConversations(
    codexAuth.endpoint,
    workspace.ready && workspace.state.provider !== "offline",
    tab,
  );
  const [settingsSection, setSettingsSection] = useState<
    "plugins" | "records"
  >();
  /**
   * Studio tabs the user has opened, which the sidebar lists as shortcuts.
   * Membership is all that matters: the sidebar orders them by registration,
   * so a shortcut never moves once it appears.
   */
  const [openedStudios, setOpenedStudios] = useState<string[]>([]);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogRequest>();
  const navigation = useRef<Array<{ tab: Tab; sessionId: string | null }>>([
    { tab: "chat", sessionId: null },
  ]);
  const [navigationIndex, setNavigationIndex] = useState(0);
  const navigationIntent = useRef(0);
  const assistantViewRestored = useRef(false);
  const assistantViewKey = `aura.assistant.view:${codexAuth.endpoint}`;
  useEffect(() => {
    if (!workspace.ready || assistantViewRestored.current) return;
    assistantViewRestored.current = true;
    try {
      if (localStorage.getItem(assistantViewKey) === "assistant") {
        navigation.current = [{ tab: "assistant", sessionId: null }];
        setTab("assistant");
      }
    } catch {
      /* Navigation still works when browser storage is unavailable. */
    }
  }, [workspace.ready, assistantViewKey]);
  const { assistant, loadAssistant } = codingWorkspaces;
  const hasAssistant = Boolean(assistant);
  useEffect(() => {
    if (tab === "assistant" && !hasAssistant) void loadAssistant();
  }, [tab, hasAssistant, loadAssistant]);
  const [systemReduced, setSystemReduced] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const assistantToggle = useRef<HTMLButtonElement>(null);
  const systemTheme = useColorScheme();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const sidebarWidth = Math.round(
    Math.max(
      240,
      Math.min(
        480,
        width - 560,
        workspace.state.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
      ),
    ),
  );
  const split = width - (wide && !collapsed ? sidebarWidth : 0) >= 930;
  const dark =
    workspace.state.theme === "system"
      ? systemTheme !== "light"
      : workspace.state.theme === "dark";
  const colors = dark ? palettes.dark : palettes.light;
  const nativeSidebar =
    workspace.ready &&
    platform() === "desktop" &&
    window.auraHost?.os === "darwin";
  const reduced = systemReduced || workspace.state.reduceMotion;
  const pluginStudio = isPluginTab(tab)
    ? pluginPages.studios.find((studio) => studio.id === tab)
    : undefined;
  const pagePluginId = pluginStudio?.pluginId;
  const pluginSettingsPages = useMemo(
    () =>
      new Map(
        pluginPages.studios
          .filter((studio) => studio.page.definition.id === "settings")
          .map((studio) => [studio.pluginId, studio.id] as const),
      ),
    [pluginPages.studios],
  );
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
  const activeConversation =
    tab === "assistant"
      ? codingWorkspaces.assistant?.conversation
      : codingWorkspaces.selectedId
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
    const pageFill = nativeSidebar ? "transparent" : colors.background;
    document.documentElement.style.backgroundColor = pageFill;
    document.body.style.backgroundColor = pageFill;
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    // Fonts are theme-independent; the document carries them so body text
    // outside the workbench root (dialogs, plugin pages) uses the same stack.
    document.documentElement.style.setProperty("--font-text", fonts.body);
    document.documentElement.style.setProperty("--font-mono", fonts.mono);
    document.title = documentTitle;
  }, [colors.background, dark, documentTitle, nativeSidebar]);
  useEffect(() => {
    if (tab === "chat" && navigation.current[navigationIndex]?.tab === "chat")
      navigation.current[navigationIndex].sessionId =
        workspace.active?.id ?? null;
  }, [tab, navigationIndex, workspace.active?.id]);
  useEffect(() => {
    if (workspace.ready)
      void window.auraHost?.chrome
        ?.setTheme(dark, workspace.state.theme)
        .catch(() => {});
  }, [dark, workspace.ready, workspace.state.theme]);
  useEffect(() => {
    if (!wide && sidebarOpen) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      document
        .querySelector<HTMLButtonElement>(
          '.workspace-menubar button[title="切换侧栏"]',
        )
        ?.focus({ preventScroll: true });
    }
  }, [wide, sidebarOpen]);

  const remember = (next: Tab, sessionId = workspace.active?.id ?? null) => {
    navigationIntent.current++;
    try {
      if (next === "assistant")
        localStorage.setItem(assistantViewKey, "assistant");
      else localStorage.removeItem(assistantViewKey);
    } catch {
      /* In-memory navigation remains available. */
    }
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
    navigationIntent.current++;
    try {
      if (next.tab === "assistant")
        localStorage.setItem(assistantViewKey, "assistant");
      else localStorage.removeItem(assistantViewKey);
    } catch {
      /* In-memory navigation remains available. */
    }
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
  /** Archived conversations are a sidebar filter, not a page of their own. */
  const openArchived = () => {
    setShowArchived(true);
    if (wide) setCollapsed(false);
    else setSidebarOpen(true);
  };
  const toggleTheme = () =>
    workspace.setState((s) => ({ ...s, theme: dark ? "light" : "dark" }));
  const navigate = (next: Tab) => {
    if (next === tab && isStudio(next)) return;
    if (!canLeaveStudio()) return;
    setStudioDirty(false);
    remember(next);
    setTab(next);
    setSettingsSection(undefined);
    if (isPluginTab(next))
      setOpenedStudios((current) =>
        current.includes(next) ? current : [...current, next],
      );
    if (next === "flows") {
      setWorkflowBrowseRevision((value) => value + 1);
      setAssistantOpen(false);
    }
    setSidebarOpen(false);
  };
  /**
   * Drops a studio from the sidebar shortcuts. Closing the page in view also
   * leaves it, since the open studio always keeps a shortcut.
   */
  const closeStudio = (id: string) => {
    if (id === tab) {
      if (!canLeaveStudio()) return;
      setStudioDirty(false);
      remember("studios");
      setTab("studios");
    }
    setOpenedStudios((current) => current.filter((item) => item !== id));
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
  const openPersonalAssistant = async () => {
    if (tab === "assistant" && hasAssistant) {
      setSidebarOpen(false);
      return;
    }
    if (!canLeaveStudio()) return;
    const intent = ++navigationIntent.current;
    if (
      (hasAssistant || (await loadAssistant(true))) &&
      intent === navigationIntent.current
    ) {
      workspace.newChat();
      navigate("assistant");
    }
  };
  const forkConversation = (
    projectId: string,
    sessionId: string,
    endSeq: number,
  ) => {
    codingWorkspaces.fork(projectId, sessionId, endSeq);
    workspace.newChat();
    navigate("studio:coding");
    setSidebarOpen(false);
  };
  const sidebar = (
    <WorkspaceSidebar
      workspace={workspace}
      tab={tab}
      dark={dark}
      toggleTheme={toggleTheme}
      onOpenArchived={openArchived}
      onAssistant={() => void openPersonalAssistant()}
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
      openedStudios={openedStudios}
      closeStudio={closeStudio}
      scheduledIds={scheduledIds}
    />
  );
  const showChat =
    tab === "chat" ||
    tab === "assistant" ||
    tab === "studio:coding" ||
    (tab === "flows" &&
      workflowDetail &&
      assistantOpen &&
      !workspace.active?.workflow);
  const showWorkflowChat =
    Boolean(workspace.active?.workflow) &&
    tab === "chat" &&
    workflowDiscussionId !== workspace.active?.id;
  const codingHeader =
    tab === "assistant" ||
    (workspace.state.provider !== "offline" &&
      (tab === "studio:coding" || (tab === "chat" && !showWorkflowChat)));
  /** View commands of the hosting page join the session menu as one "..." entry. */
  const headerActions = (viewItems: WorkbenchMenuItem[] = []) =>
    (tab === "chat" && workspace.active) ||
    (tab === "flows" && workflowDetail) ? (
      <div className="header-actions">
        {tab === "chat" && workspace.active ? (
          <>
            <SessionStatus
              status={sidebarSessionStatus(
                workspace.active,
                workspace.runningIds.includes(workspace.active.id),
              )}
              text={wide}
            />
            <SessionActions
              session={workspace.active}
              workspace={workspace}
              onDialog={setSessionDialog}
              className="icon-control header-session-more"
              leadingItems={viewItems}
            />
          </>
        ) : null}
        {tab === "flows" && workflowDetail ? (
          <button
            ref={assistantToggle}
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
      </div>
    ) : undefined;
  const navigationBar = (
    <WorkspaceMenubar
      sidebarVisible={wide ? !collapsed : sidebarOpen}
      canBack={navigationIndex > 0}
      canForward={navigationIndex < navigation.current.length - 1}
      back={() => travel(-1)}
      forward={() => travel(1)}
      toggleSidebar={toggleSidebar}
    />
  );
  const navigationInDrawer = !wide && sidebarOpen;
  const workbench = (
    <PluginResultsProvider results={pluginPages.results}>
      <ThemeContext.Provider value={{ colors, dark, reduced }}>
        <div
          className="aura-root workbench"
          data-reduced={reduced}
          data-platform={platform()}
          data-os={window.auraHost?.os}
          data-native-sidebar={nativeSidebar || undefined}
          data-theme={dark ? "dark" : "light"}
          data-titlebar-layout={
            platform() === "desktop" &&
            window.auraHost?.os === "darwin" &&
            wide &&
            !workspace.saveError
              ? codingHeader
                ? "conversation"
                : "page"
              : undefined
          }
          data-sidebar-collapsed={collapsed || undefined}
          style={
            Object.fromEntries(
              Object.entries(colors).map(([key, value]) => [`--${key}`, value]),
            ) as React.CSSProperties
          }
        >
          <ToastProvider>
            <React.Suspense
              fallback={<div className="workspace-loading">正在打开页面…</div>}
            >
              {!workspace.ready ? (
                <div className="workspace-loading">
                  <ActivityIndicator color={colors.accent} />
                  正在打开工作台
                </div>
              ) : (
                <>
                  {navigationInDrawer ? (
                    <div className="workspace-navigation-space" />
                  ) : (
                    navigationBar
                  )}
                  <div
                    className="workspace-body"
                    style={
                      {
                        "--sidebar-width": `${sidebarWidth}px`,
                      } as React.CSSProperties
                    }
                  >
                    {wide ? (
                      <ResizableSidebar
                        collapsed={collapsed}
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
                        inert={!navigationInDrawer}
                        onCancel={(event) => {
                          event.preventDefault();
                          setSidebarOpen(false);
                        }}
                        onClick={(event) => {
                          if (event.target === event.currentTarget)
                            setSidebarOpen(false);
                        }}
                      >
                        {navigationInDrawer ? navigationBar : null}
                        {sidebar}
                      </dialog>
                    ) : null}
                    <main className="workspace-main">
                      {!codingHeader ? (
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
                                  : (activeConversation?.title ?? "新任务")
                                : currentTitle}
                            </strong>
                            {tab === "chat" && workspace.active?.archivedAt ? (
                              <span className="header-archived">已归档</span>
                            ) : null}
                          </div>
                          {headerActions()}
                        </header>
                      ) : null}
                      {workspace.saveError ? (
                        <div className="workspace-notice" role="alert">
                          {workspace.saveError}
                        </div>
                      ) : null}
                      <React.Suspense
                        fallback={
                          <div className="workspace-loading" role="status">
                            正在加载内容…
                          </div>
                        }
                      >
                        <div
                          className="workspace-deck"
                          data-workflow-layout={
                            tab === "flows"
                              ? split
                                ? "split"
                                : "stacked"
                              : undefined
                          }
                          data-assistant-closed={
                            (tab === "flows" && !showChat) || undefined
                          }
                          hidden={
                            tab !== "flows" &&
                            tab !== "chat" &&
                            tab !== "assistant" &&
                            tab !== "studio:coding"
                          }
                        >
                          <div
                            className="flow-area"
                            hidden={tab !== "flows"}
                            inert={tab === "flows" && !split && showChat}
                          >
                            {flowsOpened || tab === "flows" ? (
                              <Workflows
                                browseRevision={workflowBrowseRevision}
                                endpoint={codexAuth.endpoint}
                                catalogState={catalogState}
                                onDetailChange={setWorkflowDetail}
                                onRun={(flow) => {
                                  if (workspace.state.provider === "offline") {
                                    const sessionId = workspace.newWorkflowChat(
                                      flow,
                                      codexAuth.endpoint,
                                    );
                                    remember("chat", sessionId);
                                  } else {
                                    workspace.newChat();
                                    setFlowRequest({
                                      id: crypto.randomUUID(),
                                      flow,
                                    });
                                    remember("chat", null);
                                  }
                                  setTab("chat");
                                  setAssistantOpen(false);
                                }}
                                draft={flowDraft}
                                editorRevision={editorRevision}
                                onAsk={() => {
                                  if (workspace.active?.workflow)
                                    workspace.newChat();
                                  setAssistantOpen(true);
                                  assistantToggle.current?.focus({
                                    preventScroll: true,
                                  });
                                  workspace.setDraft(
                                    "帮我完善当前工作流，检查步骤拆分、输入输出与异常处理。",
                                  );
                                }}
                              />
                            ) : null}
                          </div>
                          <div
                            className={`assistant-area${tab === "chat" || tab === "assistant" ? " standalone" : ""}`}
                            hidden={tab !== "flows" && !showChat}
                            inert={tab === "flows" && !showChat}
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
                                    onClick={() => {
                                      setAssistantOpen(false);
                                      assistantToggle.current?.focus({
                                        preventScroll: true,
                                      });
                                    }}
                                  >
                                    <X size={15} />
                                  </button>
                                </div>
                              </div>
                            ) : null}
                            {online || hasAssistant ? (
                              <div
                                className="studio-area"
                                hidden={!online}
                                style={
                                  showWorkflowChat
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
                                    personalAssistant={
                                      tab === "assistant" || !online
                                    }
                                    visible={
                                      online && showChat && !showWorkflowChat
                                    }
                                    key={codexAuth.endpoint}
                                    endpoint={codexAuth.endpoint}
                                    provider={workspace.state.provider}
                                    workspaces={codingWorkspaces}
                                    handoff={codingHandoff}
                                    onHandoffTaken={takeHandoff}
                                    onForkConversation={forkConversation}
                                    legacy={
                                      online &&
                                      tab === "chat" &&
                                      workspace.active &&
                                      !showWorkflowChat
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
                                      tab === "flows"
                                        ? workspace.draft
                                        : undefined
                                    }
                                    onApplyFlow={
                                      tab === "flows"
                                        ? (code) => {
                                            flowDraft.update(code);
                                            setEditorRevision(
                                              (value) => value + 1,
                                            );
                                            if (!split) setAssistantOpen(false);
                                          }
                                        : undefined
                                    }
                                    flows={catalogState.catalog?.flows}
                                    flowsLoading={
                                      !catalogState.catalog &&
                                      !catalogState.error
                                    }
                                    flowRequest={flowRequest}
                                    onFlowRequestTaken={takeFlowRequest}
                                    onProvider={(provider) =>
                                      workspace.setState((current) => ({
                                        ...current,
                                        provider,
                                      }))
                                    }
                                    headerActions={
                                      codingHeader ? headerActions : undefined
                                    }
                                    onBack={
                                      tab === "chat" || tab === "assistant"
                                        ? undefined
                                        : () => navigate("chat")
                                    }
                                  />
                                </React.Suspense>
                              </div>
                            ) : null}
                            {showWorkflowChat ? (
                              <React.Suspense
                                fallback={
                                  <div className="workspace-loading">
                                    正在打开执行记录…
                                  </div>
                                }
                              >
                                <WorkflowChat
                                  key={workspace.active?.id}
                                  workspace={workspace}
                                  onContinue={
                                    workspace.state.provider !== "offline" &&
                                    workspace.active?.workflow?.endpoint ===
                                      codexAuth.endpoint
                                      ? () =>
                                          setWorkflowDiscussionId(
                                            workspace.active?.id,
                                          )
                                      : undefined
                                  }
                                  flow={catalogState.catalog?.flows.find(
                                    (flow) =>
                                      flow.id ===
                                        workspace.active?.workflow?.id &&
                                      workspace.active.workflow.endpoint ===
                                        codexAuth.endpoint,
                                  )}
                                />
                              </React.Suspense>
                            ) : workspace.state.provider === "offline" &&
                              tab !== "assistant" ? (
                              <ChatScreen
                                workspace={workspace}
                                connecting={codexAuth.loading}
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
                        {tab === "studios" ? (
                          <StudiosScreen
                            studios={pluginPages.studios}
                            failures={pluginPages.failures}
                            navigate={navigate}
                            onManagePlugins={() => {
                              navigate("settings");
                              setSettingsSection("plugins");
                            }}
                          />
                        ) : null}
                        {tab === "automation" ? (
                          <AutomationScreen
                            endpoint={codexAuth.endpoint}
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
                            section={settingsSection}
                            pluginSettingsPages={pluginSettingsPages}
                            onOpenPluginSettings={navigate}
                            onHistory={() => navigate("history")}
                            onArchived={openArchived}
                          />
                        ) : null}
                      </React.Suspense>
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
                  {onReady && readySurface === startupSurface ? (
                    <WorkbenchReady
                      onReady={onReady}
                      dark={dark}
                      reduced={reduced}
                    />
                  ) : null}
                </>
              )}
            </React.Suspense>
          </ToastProvider>
        </div>
      </ThemeContext.Provider>
    </PluginResultsProvider>
  );
  return (
    <IntegrationProvider endpoint={codexAuth.endpoint}>
      {workbench}
    </IntegrationProvider>
  );
}

/** The shell can be used while its backend services prepare in parallel. */
function WorkbenchReady({
  onReady,
  dark,
  reduced,
}: WorkbenchReadyState & Required<AppProps>) {
  useEffect(() => onReady({ dark, reduced }), [onReady, dark, reduced]);
  return null;
}
