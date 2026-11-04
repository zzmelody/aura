import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Ellipsis,
  FolderPlus,
  FolderOpen,
  Globe,
  ChevronDown,
  PanelRight,
  MessageSquare,
  MessageSquareQuote,
  SquareTerminal,
} from "lucide-react";
import {
  conversationSides,
  PERSONAL_ASSISTANT_SESSION_ID,
} from "@aura/protocol/conversations";
import type { ChatImage, Session, Workspace } from "@aura/core/types";
import { providerMode } from "@aura/core";
import type {
  ChatModelSelection,
  CodingPermission,
  FlowMode,
  FlowCatalogEntry,
  WorkspaceTerminalInfo,
} from "@aura/protocol/types";
import { chatHistory } from "../../workflowSessions";
import {
  flowConversationHistory,
  type FlowConversationRequest,
} from "../../flow-conversation";
import { ConversationPane } from "./ConversationPane";
import { ConversationSplit } from "./ConversationSplit";
import { SideConversation } from "./SideConversation";
import { ToolTabs } from "./ToolTabs";
import { BrowserPane, type BrowserPageInfo } from "./BrowserPane.tsx";
import { TerminalPane } from "./TerminalPane";
import { TerminalCloseDialog } from "./TerminalCloseDialog";
import { useWorkspaceTerminals } from "./useWorkspaceTerminals";
import {
  workspaceToolTabs,
  selectedToolId,
  type WorkspaceToolTab,
} from "./tool-tabs";
import {
  loadToolLayouts,
  saveToolLayout,
  type ToolLayout,
} from "./tool-layout";
import { WorkbenchMenu, type WorkbenchMenuItem } from "../../WorkbenchMenu";
import { WorkflowApiError } from "../../workflowSessions";
import {
  codingConversationStatus,
  withSideActivity,
} from "./conversationStatus";
import type { CodingProjectsController } from "./useCodingProjects";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { Turn } from "./turns";
import { TrajectoryView } from "./TrajectoryView";
import { SelectionActions, type SelectionAction } from "./SelectionActions";
import "./coding.css";
import "./tools.css";

export type CodingHandoff = {
  id: string;
  projectId?: string;
  prompt: string;
  /** Images already uploaded on the chat page. */
  images?: ChatImage[];
  modelConfig?: ChatModelSelection;
};

/** The selected workspace conversation and its durable, per-parent side chats. */
export function CodingStudio({
  endpoint,
  visible = true,
  personalAssistant = false,
  provider,
  workspaces,
  handoff,
  onHandoffTaken,
  onForkConversation,
  onProvider,
  onBack,
  headerActions,
  legacy,
  onOpened,
  context,
  initialDraft,
  onApplyFlow,
  flows,
  flowsLoading,
  flowRequest,
  onFlowRequestTaken,
}: {
  endpoint: string;
  visible?: boolean;
  personalAssistant?: boolean;
  provider: Workspace["provider"];
  /** Workspace tree state shared with the sidebar. */
  workspaces: CodingProjectsController;
  /** A first request started from the chat page in a chosen workspace. */
  handoff?: CodingHandoff;
  onHandoffTaken?(): void;
  onProvider(provider: Workspace["provider"]): void;
  onBack?(): void;
  /** Host header actions; view items join its session menu. */
  headerActions?(viewItems: WorkbenchMenuItem[]): React.ReactNode;
  legacy?: Session;
  onOpened?(): void;
  onForkConversation?(
    projectId: string,
    sessionId: string,
    endSeq: number,
  ): void;
  context?: string;
  initialDraft?: string;
  onApplyFlow?(code: string): void;
  flows?: FlowCatalogEntry[];
  flowsLoading?: boolean;
  flowRequest?: FlowConversationRequest;
  onFlowRequestTaken?(): void;
}) {
  const {
    projects,
    selectedId,
    conversationId: selectedConversationId,
    open,
    refreshConversations,
  } = workspaces;
  const projectId = personalAssistant
    ? workspaces.assistant?.project.id
    : selectedId;
  const conversationId = personalAssistant
    ? PERSONAL_ASSISTANT_SESSION_ID
    : legacy
      ? `legacy-${legacy.id}`
      : selectedConversationId;
  const branchFrom = personalAssistant ? undefined : workspaces.branchFrom;
  const branchAt = personalAssistant ? undefined : workspaces.branchAt;
  const history = useMemo(
    () =>
      legacy
        ? legacy.workflow
          ? flowConversationHistory(legacy)
          : chatHistory(
              legacy.messages.filter((message) => message.status !== "error"),
            ).map(({ role, text, images }) => ({
              role,
              text,
              ...(images?.length
                ? { images: images.map((image) => image.assetId) }
                : {}),
            }))
        : undefined,
    [legacy],
  );
  const [creating, setCreating] = useState(false);
  const [openingSide, setOpeningSide] = useState(false);
  /**
   * Tool panel layout per main conversation, like DSH's per-session sidebar:
   * browser tabs, selected tab and visibility survive switches and reloads.
   */
  const [layouts, setLayouts] = useState(loadToolLayouts);
  const savedLayouts = useRef(layouts);
  useEffect(() => {
    const previous = savedLayouts.current;
    for (const [owner, layout] of Object.entries(layouts)) {
      if (layout !== previous[owner]) saveToolLayout(owner, layout);
    }
    for (const owner of Object.keys(previous)) {
      if (!layouts[owner]) saveToolLayout(owner, { browsers: [] });
    }
    savedLayouts.current = layouts;
  }, [layouts]);
  /**
   * Conversations whose browsers were shown this visit, with their storage
   * workspace. Only these mount guests; hidden ones stay mounted.
   */
  const [mountedBrowsers, setMountedBrowsers] = useState<
    Record<string, string>
  >({});
  const updateLayout = useCallback(
    (owner: string, change: (layout: ToolLayout) => ToolLayout) =>
      setLayouts((current) => ({
        ...current,
        [owner]: change(current[owner] ?? { browsers: [] }),
      })),
    [],
  );
  const [toolError, setToolError] = useState("");
  const browserHost = window.auraHost?.browser;
  const saveBrowserPage = useCallback(
    (id: string, page: BrowserPageInfo) =>
      setLayouts((current) => {
        for (const [owner, layout] of Object.entries(current)) {
          const tab = layout.browsers.find((item) => item.id === id);
          if (!tab) continue;
          if (tab.url === page.url && tab.title === page.title) return current;
          const next = {
            ...layout,
            browsers: layout.browsers.map((item) =>
              item.id === id ? { ...item, ...page } : item,
            ),
          };
          return { ...current, [owner]: next };
        }
        return current;
      }),
    [],
  );
  const [closingTools, setClosingTools] = useState<string[]>([]);
  const [confirmTerminal, setConfirmTerminal] =
    useState<WorkspaceTerminalInfo>();
  const [draftInserts, setDraftInserts] = useState<
    Record<string, { id: string; text: string }>
  >({});
  const [sideInserts, setSideInserts] = useState<
    Record<string, { id: string; text: string }>
  >({});
  const studioRoot = useRef<HTMLElement>(null);
  const terminals = useWorkspaceTerminals(endpoint, projectId);
  const [mainRunning, setMainRunning] = useState(false);
  /** Main conversation's turns, mirrored for the trajectory view. */
  const [mainTurns, setMainTurns] = useState<readonly Turn[]>([]);
  const [selectedView, setView] = useState<"chat" | "trajectory">("chat");
  const view = branchFrom ? "chat" : selectedView;
  const [modelConfigs, setModelConfigs] = useState<
    Record<string, Partial<Record<FlowMode, ChatModelSelection>>>
  >({});
  const [draftPermissions, setDraftPermissions] = useState<
    Partial<Record<string, CodingPermission>>
  >({});
  const sideToggle = useRef<HTMLButtonElement>(null);
  const hideTools = useRef<HTMLButtonElement>(null);
  const moveToolFocus = useRef(false);
  const closingSides = useRef(new Set<string>());
  const selection = useRef({ conversationId, mainRunning });
  selection.current = { conversationId, mainRunning };
  const { reportStatus } = workspaces;
  /** Side chats with a live turn, keyed by side session id. */
  const [sideRunning, setSideRunning] = useState<Record<string, boolean>>({});
  const reportSideRunning = useCallback(
    (sessionId: string, running: boolean) =>
      setSideRunning((current) =>
        !!current[sessionId] === running
          ? current
          : { ...current, [sessionId]: running },
      ),
    [],
  );
  const sideActive = useRef(false);
  /** The conversation `mainTurns` belongs to, so a switch never mislabels a row. */
  const mainTurnsOwner = useRef<string | undefined>(undefined);
  /**
   * Publishes the open conversation's live status. Other rows keep the status
   * the server reports, so switching away never blanks their badge.
   */
  const reportTurns = useCallback(
    (turns: readonly Turn[]) => {
      const current = selection.current.conversationId;
      mainTurnsOwner.current = current;
      setMainTurns(turns);
      if (current)
        reportStatus(
          current,
          withSideActivity(codingConversationStatus(turns), sideActive.current),
        );
    },
    [reportStatus],
  );

  const project = personalAssistant
    ? workspaces.assistant?.project
    : projects.find((item) => item.id === projectId);
  const conversation = personalAssistant
    ? workspaces.assistant?.conversation
    : project
      ? workspaces.conversations[project.id]?.find(
          (item) => item.id === conversationId,
        )
      : undefined;
  const currentSides =
    conversation && conversation.archivedAt === undefined
      ? conversationSides(conversation)
      : [];
  const currentSideRunning = currentSides.some((side) => sideRunning[side.id]);
  sideActive.current = currentSideRunning;
  // Re-publish when only a side chat starts or settles; main turns are unchanged.
  useEffect(() => {
    if (!conversationId || mainTurnsOwner.current !== conversationId) return;
    reportStatus(
      conversationId,
      withSideActivity(codingConversationStatus(mainTurns), currentSideRunning),
    );
  }, [conversationId, currentSideRunning, mainTurns, reportStatus]);
  const toolKey = `${endpoint}:${projectId ?? ""}`;
  // A draft has no session id yet; its layout moves to the session on first send.
  const layoutOwner = conversationId
    ? `${endpoint}:${conversationId}`
    : `draft:${toolKey}`;
  const layout = layouts[layoutOwner];
  const tabs = workspaceToolTabs(
    currentSides,
    terminals.current,
    browserHost ? layout?.browsers : undefined,
  );
  const activeToolId = selectedToolId(tabs, layout?.selected);
  const sideVisible =
    !!project &&
    layout?.visible !== false &&
    (layout?.visible === true || tabs.length > 0);
  const setSideVisible = (visible: boolean) =>
    updateLayout(layoutOwner, (current) => ({ ...current, visible }));
  // Browser storage is grouped by workspace directory, as in DSH Desktop.
  const browserWorkspace = project
    ? `${endpoint}:${project.directory}`
    : undefined;
  const showBrowsers = visible && sideVisible && !!layout?.browsers.length;
  useEffect(() => {
    if (!browserHost || !browserWorkspace || !showBrowsers) return;
    setMountedBrowsers((current) =>
      current[layoutOwner]
        ? current
        : { ...current, [layoutOwner]: browserWorkspace },
    );
  }, [browserHost, browserWorkspace, layoutOwner, showBrowsers]);
  useEffect(() => {
    if (!moveToolFocus.current) return;
    moveToolFocus.current = false;
    (sideVisible ? hideTools : sideToggle).current?.focus({
      preventScroll: true,
    });
  }, [sideVisible]);
  const selectTool = (id: string) =>
    updateLayout(layoutOwner, (current) => ({ ...current, selected: id }));
  /** Selects a tool and expands the panel in one saved change. */
  const showTool = (id: string) =>
    updateLayout(layoutOwner, (current) => ({
      ...current,
      selected: id,
      visible: true,
    }));
  const title = personalAssistant
    ? "Aura"
    : (conversation?.title ?? legacy?.title ?? "新任务");
  const offline = provider === "offline";
  const refresh = useCallback(() => {
    if (project) void refreshConversations(project.id).catch(() => {});
  }, [project, refreshConversations]);
  const initialSend =
    !personalAssistant &&
    handoff &&
    project &&
    (!handoff.projectId || project.id === handoff.projectId)
      ? handoff
      : undefined;
  const mode = providerMode(provider);
  const sourceId = branchFrom ?? conversation?.sourceSessionId;
  const sourceParent =
    sourceId && sourceId !== PERSONAL_ASSISTANT_SESSION_ID
      ? Object.values(workspaces.conversations)
          .flat()
          .find(
            (item) =>
              item.id === sourceId ||
              conversationSides(item).some((side) => side.id === sourceId),
          )
      : undefined;
  const source =
    sourceId === PERSONAL_ASSISTANT_SESSION_ID
      ? workspaces.assistant?.conversation
      : sourceParent?.id === sourceId
        ? sourceParent
        : sourceParent &&
          conversationSides(sourceParent).find((side) => side.id === sourceId);
  const configKey =
    conversationId ??
    (branchFrom
      ? `fork:${branchFrom}:${branchAt ?? "latest"}`
      : `draft:${projectId}`);
  const modelConfig =
    initialSend?.modelConfig ??
    conversation?.modelConfig?.[mode] ??
    modelConfigs[configKey]?.[mode] ??
    legacy?.modelConfig?.[mode] ??
    source?.modelConfig?.[mode] ??
    {};
  const permissionKey = JSON.stringify([endpoint, projectId, configKey]);
  const draftPermission = !conversation
    ? draftPermissions[permissionKey]
    : undefined;
  const { pendingPermissions } = workspaces;
  const pendingPermission = conversationId
    ? pendingPermissions[conversationId]
    : undefined;
  const sourcePermission =
    branchFrom && !conversation
      ? (source?.permission ?? sourceParent?.permission)
      : undefined;
  const permission =
    pendingPermission ??
    conversation?.permission ??
    draftPermission ??
    sourcePermission;
  const changePermission = async (next: CodingPermission) => {
    if (conversation) {
      await workspaces.selectPermission(conversation.id, next);
      return;
    }
    setDraftPermissions((current) => ({ ...current, [permissionKey]: next }));
  };
  const changeModel = (key: string, selection: ChatModelSelection) => {
    if (key === conversation?.id || key.startsWith("side-")) {
      void workspaces.selectModel(key, mode, selection).catch(() => {});
      return;
    }
    setModelConfigs((current) => ({
      ...current,
      [key]: { ...current[key], [mode]: selection },
    }));
  };

  const openSide = async (): Promise<string | undefined> => {
    if (!conversation || openingSide) return undefined;
    setOpeningSide(true);
    setSideVisible(true);
    try {
      const id = await workspaces.openSide(
        conversation.projectId,
        conversation.id,
      );
      selectTool(id);
      return id;
    } catch {
      // The controller keeps the service error visible above the transcript.
      return undefined;
    } finally {
      setOpeningSide(false);
    }
  };

  /** Puts a quoted selection into the main conversation's draft. */
  const quoteToMain = (quote: string) => {
    if (!conversationId) return;
    setDraftInserts((current) => ({
      ...current,
      [conversationId]: { id: crypto.randomUUID(), text: quote },
    }));
    setView("chat");
  };

  /** Puts a quoted selection into the active side chat, opening one if needed. */
  const quoteToSide = async (quote: string) => {
    const active = tabs.find(
      (tab) => tab.id === activeToolId && tab.kind === "chat",
    );
    const sideId = active?.id ?? (await openSide());
    if (!sideId) return;
    showTool(sideId);
    setSideInserts((current) => ({
      ...current,
      [sideId]: { id: crypto.randomUUID(), text: quote },
    }));
  };
  const mainReadOnly =
    conversation?.archivedAt !== undefined || legacy?.archivedAt !== undefined;
  const selectionActions: SelectionAction[] = [
    {
      id: "main",
      label: "发送到对话",
      icon: <MessageSquareQuote size={13} />,
      disabled: !conversationId || mainReadOnly,
      run: quoteToMain,
    },
    {
      id: "side",
      label: "发送到侧边对话",
      icon: <PanelRight size={13} />,
      disabled:
        !conversation ||
        conversation.archivedAt !== undefined ||
        offline ||
        openingSide,
      run: (quote) => void quoteToSide(quote),
    },
  ];

  const closeSide = async (projectId: string, sessionId: string) => {
    closingSides.current.add(sessionId);
    try {
      await workspaces.closeSide(projectId, sessionId);
    } finally {
      closingSides.current.delete(sessionId);
    }
  };

  const sendBack = useCallback(
    (parentId: string, sideId: string, summary: string) => {
      if (
        closingSides.current.has(sideId) ||
        selection.current.conversationId !== parentId
      )
        return false;
      setDraftInserts((current) => ({
        ...current,
        [parentId]: {
          id: crypto.randomUUID(),
          text: `侧边对话结论：

${summary}`,
        },
      }));
      setView("chat");
      return true;
    },
    [],
  );

  const createTerminal = async () => {
    setSideVisible(true);
    const info = await terminals.create();
    if (info) selectTool(info.id);
  };
  const openBrowser = () => {
    const id = `browser-${crypto.randomUUID()}`;
    updateLayout(layoutOwner, (current) => ({
      ...current,
      browsers: [...current.browsers, { id, title: "浏览器", url: "" }],
      selected: id,
      visible: true,
    }));
  };
  const closeTool = async (tab: WorkspaceToolTab) => {
    if (!project || closingTools.includes(tab.id)) return;
    if (tab.kind === "browser") {
      updateLayout(layoutOwner, (current) => ({
        ...current,
        browsers: current.browsers.filter((browser) => browser.id !== tab.id),
        selected: current.selected === tab.id ? undefined : current.selected,
      }));
      return;
    }
    setClosingTools((current) => [...current, tab.id]);
    setToolError("");
    const info = terminals.current.find((item) => item.id === tab.id);
    try {
      if (tab.kind === "chat") await closeSide(project.id, tab.id);
      else if (info) await terminals.close(info);
    } catch (error) {
      if (info && error instanceof WorkflowApiError && error.status === 409)
        setConfirmTerminal(info);
      else setToolError("工具未能关闭，请检查服务连接后重试。仍可收起面板。");
    } finally {
      setClosingTools((current) => current.filter((id) => id !== tab.id));
    }
  };

  // Navigation only hides a side; explicit closure or parent archival removes it.
  const sides = projects.flatMap((space) =>
    (workspaces.conversations[space.id] ?? []).flatMap((parent) => {
      return parent.archivedAt === undefined
        ? conversationSides(parent).map((side) => {
            const sessionId = side.id;
            const selected =
              parent.id === conversationId && sessionId === activeToolId;
            return (
              <SideConversation
                key={sessionId}
                endpoint={endpoint}
                provider={provider}
                project={space}
                parentId={parent.id}
                sessionId={sessionId}
                title={side.title}
                selected={selected}
                visible={visible && sideVisible && selected}
                modelConfig={
                  side.modelConfig?.[mode] ?? parent.modelConfig?.[mode] ?? {}
                }
                onModelConfig={(selection) => changeModel(sessionId, selection)}
                permission={
                  pendingPermissions[sessionId] ??
                  side.permission ??
                  pendingPermissions[parent.id] ??
                  parent.permission
                }
                permissionSaving={
                  !!pendingPermissions[sessionId] ||
                  (!side.permission && !!pendingPermissions[parent.id])
                }
                onPermission={(next) =>
                  workspaces.selectPermission(sessionId, next)
                }
                onProvider={onProvider}
                flows={flows}
                flowsLoading={flowsLoading}
                onSendBack={sendBack}
                onForkTurn={
                  onForkConversation && !offline
                    ? (endSeq) =>
                        onForkConversation(space.id, sessionId, endSeq)
                    : undefined
                }
                draftInsert={sideInserts[sessionId]}
                onRunning={reportSideRunning}
                onSettled={() =>
                  void refreshConversations(space.id).catch(() => {})
                }
              />
            );
          })
        : [];
    }),
  );

  const viewItems: WorkbenchMenuItem[] = project
    ? [
        { id: "chat", label: "对话", action: () => setView("chat") },
        {
          id: "trajectory",
          label: "执行记录",
          action: () => setView("trajectory"),
          disabled: Boolean(branchFrom),
        },
      ]
    : [];
  const hostActions = headerActions?.(viewItems);
  const mainHeader = (
    <header className="coding-header coding-title-row">
      {onBack ? (
        <button
          type="button"
          className="icon-control studio-back"
          aria-label="返回对话"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
      ) : null}
      <strong
        className="coding-title"
        title={
          project ? `${title}\n${project.title} · ${project.directory}` : title
        }
      >
        {title}
      </strong>
      {conversation?.archivedAt !== undefined ||
      legacy?.archivedAt !== undefined ? (
        <span className="header-archived">已归档</span>
      ) : null}
      {/* One "..." per header: the view items join the host's session menu,
          and only stand alone when the host has no session menu to offer. */}
      {hostActions ??
        (project ? (
          <WorkbenchMenu label="对话菜单" items={viewItems}>
            <Ellipsis size={16} />
          </WorkbenchMenu>
        ) : null)}
      {project && !sideVisible ? (
        <button
          ref={sideToggle}
          type="button"
          className="icon-control"
          aria-label="工具面板"
          aria-expanded={sideVisible}
          title="打开工具面板"
          onClick={() => {
            moveToolFocus.current = true;
            setSideVisible(true);
          }}
        >
          <PanelRight size={16} />
        </button>
      ) : null}
    </header>
  );

  return (
    <section
      ref={studioRoot}
      className={`coding-studio chat-screen studio-main${sideVisible ? " with-side" : ""}`}
      aria-label="工作空间对话"
    >
      {visible ? (
        <SelectionActions root={studioRoot} actions={selectionActions} />
      ) : null}
      <ConversationSplit
        mainHeader={mainHeader}
        sideHeader={
          <ToolTabs
            tabs={tabs}
            selectedId={activeToolId}
            busy={openingSide || terminals.creating}
            closing={closingTools}
            canChat={
              !!conversation &&
              conversation.archivedAt === undefined &&
              !offline
            }
            onSelect={selectTool}
            onChat={() => void openSide()}
            onTerminal={() => void createTerminal()}
            onBrowser={browserHost ? openBrowser : undefined}
            onClose={(tab) => void closeTool(tab)}
            hideButtonRef={hideTools}
            onHide={() => {
              moveToolFocus.current = true;
              setSideVisible(false);
            }}
          />
        }
        main={
          <>
            {workspaces.error ? (
              <p className="coding-notice" role="alert">
                {workspaces.error}
              </p>
            ) : null}
            {branchFrom ? (
              <p className="coding-notice">
                将继承{source ? `「${source.title}」` : "来源对话"}
                {branchAt === undefined ? "的上下文" : "截至所选回复的上下文"}
                。发送第一条消息后保存为独立会话。
              </p>
            ) : null}
            {view === "trajectory" ? (
              <div className="studio-scroll coding-trajectory">
                <TrajectoryView turns={mainTurns} />
              </div>
            ) : null}
            <div
              className="coding-pane coding-main-transcript"
              hidden={view !== "chat"}
            >
              <ConversationPane
                endpoint={endpoint}
                visible={visible && view === "chat"}
                preparing={!workspaces.ready}
                provider={provider}
                projectId={project?.id}
                directory={project?.directory}
                label={
                  personalAssistant ? "Aura 助手输入框" : "工作空间请求输入框"
                }
                {...(conversationId ? { sessionId: conversationId } : {})}
                readOnly={
                  conversation?.archivedAt !== undefined ||
                  legacy?.archivedAt !== undefined
                }
                placeholder={
                  !project || project.isDefault
                    ? "描述你想讨论或完成的事情…"
                    : `在「${project.title}」中描述要完成的事情…`
                }
                branchFrom={branchFrom}
                branchAt={branchAt}
                onForkTurn={
                  onForkConversation && conversation && !offline
                    ? (endSeq) =>
                        onForkConversation(
                          conversation.projectId,
                          conversation.id,
                          endSeq,
                        )
                    : undefined
                }
                history={history}
                historyTime={legacy?.updatedAt}
                context={context}
                initialDraft={initialDraft}
                draftInsert={
                  conversationId ? draftInserts[conversationId] : undefined
                }
                onApplyFlow={onApplyFlow}
                flows={flows}
                flowsLoading={flowsLoading}
                flowRequest={flowRequest}
                onFlowRequestTaken={onFlowRequestTaken}
                composerLeading={
                  !conversationId ? (
                    <WorkbenchMenu
                      label="选择工作空间"
                      className="composer-context"
                      title={project?.title ?? "选择工作空间"}
                      disabled={mainRunning || personalAssistant}
                      items={[
                        ...projects.map((item) => ({
                          id: item.id,
                          label: `${item.id === project?.id ? "✓ " : ""}${item.title}`,
                          icon: <FolderOpen size={14} />,
                          action: () => {
                            if (legacy) workspaces.select(item.id);
                            else workspaces.continueIn(item.id);
                          },
                        })),
                        ...(projects.length
                          ? [{ id: "separator", separator: true as const }]
                          : []),
                        {
                          id: "create",
                          label: "新建工作空间",
                          icon: <FolderPlus size={14} />,
                          action: () => setCreating(true),
                        },
                      ]}
                    >
                      <FolderOpen size={14} />
                      <span>{project?.title ?? "工作空间"}</span>
                      <ChevronDown size={12} />
                    </WorkbenchMenu>
                  ) : undefined
                }
                footnote={
                  offline
                    ? "工作空间需要连接 Aura 服务，请切换到 Codex 订阅或其他模式"
                    : !project
                      ? "工作空间暂不可用，仍可查看历史和编辑草稿；选择或新建工作空间后可继续发送。"
                      : !workspaces.ready
                        ? "服务正在连接，你可以先提交任务。"
                        : undefined
                }
                onOpen={(id, submittedConfig) => {
                  if (!project) return;
                  if (personalAssistant) return;
                  if (branchFrom) setView("chat");
                  if (id !== configKey)
                    setModelConfigs((current) => {
                  if (draftPermission && !conversationId)
                    setDraftPermissions((current) => {
                      const next = {
                        ...current,
                        [JSON.stringify([endpoint, projectId, id])]:
                          draftPermission,
                      };
                      delete next[permissionKey];
                      return next;
                    });
                      const next = {
                        ...current,
                        [id]: {
                          ...current[configKey],
                          [mode]: submittedConfig ?? modelConfig,
                        },
                      };
                      delete next[configKey];
                      return next;
                    });
                  if (!conversationId) {
                    const owner = `${endpoint}:${id}`;
                    setLayouts((current) => {
                      const { [layoutOwner]: draft, ...remaining } = current;
                      return draft ? { ...remaining, [owner]: draft } : current;
                    });
                    setMountedBrowsers((current) => {
                      const { [layoutOwner]: workspace, ...remaining } =
                        current;
                      return workspace
                        ? { ...remaining, [owner]: workspace }
                        : current;
                    });
                  }
                  open(project.id, id);
                  onOpened?.();
                }}
                onSettled={refresh}
                onProvider={onProvider}
                modelConfig={modelConfig}
                onModelConfig={(selection) => changeModel(configKey, selection)}
                {...(initialSend ? { initialSend } : {})}
                {...(onHandoffTaken
                permission={permission}
                draftPermission={draftPermission}
                permissionSaving={!!pendingPermission}
                onPermission={
                  conversation || !conversationId || legacy
                    ? changePermission
                    : undefined
                }
                  ? { onInitialSendTaken: onHandoffTaken }
                  : {})}
                onRunning={setMainRunning}
                onTurns={reportTurns}
              />
            </div>
          </>
        }
        side={
          <>
            {toolError || terminals.error ? (
              <p className="coding-notice" role="alert">
                {toolError || terminals.error}
              </p>
            ) : null}
            {!tabs.length ? (
              <div className="coding-tools-empty">
                <strong>打开工具</strong>
                <button
                  type="button"
                  className="tool-button"
                  disabled={
                    !conversation ||
                    conversation.archivedAt !== undefined ||
                    openingSide
                  }
                  onClick={() => void openSide()}
                >
                  <MessageSquare size={15} />
                  侧边对话
                </button>
                <button
                  type="button"
                  className="tool-button"
                  disabled={terminals.creating}
                  onClick={() => void createTerminal()}
                >
                  <SquareTerminal size={15} />
                  终端
                </button>
                {browserHost ? (
                  <button
                    type="button"
                    className="tool-button"
                    onClick={openBrowser}
                  >
                    <Globe size={15} />
                    浏览器
                  </button>
                ) : null}
              </div>
            ) : null}
            {sides}
            {browserHost &&
              Object.entries(mountedBrowsers).flatMap(([owner, workspace]) =>
                (layouts[owner]?.browsers ?? []).map((tab) => (
                  <BrowserPane
                    key={tab.id}
                    id={tab.id}
                    workspace={workspace}
                    saved={tab}
                    host={browserHost}
                    visible={
                      visible &&
                      sideVisible &&
                      owner === layoutOwner &&
                      tab.id === activeToolId
                    }
                    onPage={saveBrowserPage}
                  />
                )),
              )}
            {terminals.all.map((info) => (
              <TerminalPane
                key={`${endpoint}:${info.id}`}
                endpoint={endpoint}
                info={info}
                visible={
                  info.projectId === project?.id && info.id === activeToolId
                }
                onInfo={terminals.update}
              />
            ))}
          </>
        }
        sideVisible={sideVisible}
      />
      {confirmTerminal ? (
        <TerminalCloseDialog
          terminal={confirmTerminal}
          onCancel={() => setConfirmTerminal(undefined)}
          onConfirm={async () => {
            await terminals.close(confirmTerminal, true);
            setConfirmTerminal(undefined);
          }}
        />
      ) : null}
      {creating ? (
        <WorkspaceDialog
          endpoint={endpoint}
          onSaved={(saved) => {
            void workspaces
              .refresh()
              .then(() => open(saved.id))
              .catch(() => {});
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </section>
  );
}
