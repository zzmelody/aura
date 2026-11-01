import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  FolderPlus,
  PanelRight,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { conversationSides } from "@aura/protocol/conversations";
import type { ChatImage, Session, Workspace } from "@aura/core/types";
import { providerMode } from "@aura/core";
import type {
  ChatModelSelection,
  FlowMode,
  FlowCatalogEntry,
  WorkspaceTerminalInfo,
} from "@aura/protocol/types";
import { chatHistory } from "../../workflowSessions";
import { ConversationPane } from "./ConversationPane";
import { ConversationSplit } from "./ConversationSplit";
import { SideConversation } from "./SideConversation";
import { ToolTabs } from "./ToolTabs";
import { TerminalPane } from "./TerminalPane";
import { TerminalCloseDialog } from "./TerminalCloseDialog";
import { useWorkspaceTerminals } from "./useWorkspaceTerminals";
import {
  workspaceToolTabs,
  selectedToolId,
  type WorkspaceToolTab,
} from "./tool-tabs";
import { WorkbenchMenu } from "../../WorkbenchMenu";
import { WorkflowApiError } from "../../workflowSessions";
import { codingConversationStatus } from "./conversationStatus";
import type { CodingProjectsController } from "./useCodingProjects";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { Turn } from "./turns";
import { TrajectoryView } from "./TrajectoryView";
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
  provider,
  workspaces,
  handoff,
  onHandoffTaken,
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
  onRunFlow,
}: {
  endpoint: string;
  visible?: boolean;
  provider: Workspace["provider"];
  /** Workspace tree state shared with the sidebar. */
  workspaces: CodingProjectsController;
  /** A first request started from the chat page in a chosen workspace. */
  handoff?: CodingHandoff;
  onHandoffTaken?(): void;
  onProvider(provider: Workspace["provider"]): void;
  onBack?(): void;
  headerActions?: React.ReactNode;
  legacy?: Session;
  onOpened?(): void;
  context?: string;
  initialDraft?: string;
  onApplyFlow?(code: string): void;
  flows?: FlowCatalogEntry[];
  flowsLoading?: boolean;
  onRunFlow?(flow: FlowCatalogEntry): void;
}) {
  const {
    projects,
    selectedId: projectId,
    conversationId: selectedConversationId,
    open,
    refreshConversations,
  } = workspaces;
  const conversationId = legacy
    ? `legacy-${legacy.id}`
    : selectedConversationId;
  const history = useMemo(
    () =>
      legacy
        ? chatHistory(
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
  const [toolSelections, setToolSelections] = useState<Record<string, string>>(
    {},
  );
  const [toolVisibility, setToolVisibility] = useState<Record<string, boolean>>(
    {},
  );
  const [toolError, setToolError] = useState("");
  const [closingTools, setClosingTools] = useState<string[]>([]);
  const [confirmTerminal, setConfirmTerminal] =
    useState<WorkspaceTerminalInfo>();
  const [draftInserts, setDraftInserts] = useState<
    Record<string, { id: string; text: string }>
  >({});
  const terminals = useWorkspaceTerminals(endpoint, projectId);
  const [mainRunning, setMainRunning] = useState(false);
  /** Main conversation's turns, mirrored for the trajectory view. */
  const [mainTurns, setMainTurns] = useState<readonly Turn[]>([]);
  const [view, setView] = useState<"chat" | "trajectory">("chat");
  const [modelConfigs, setModelConfigs] = useState<
    Record<string, Partial<Record<FlowMode, ChatModelSelection>>>
  >({});
  const sideToggle = useRef<HTMLButtonElement>(null);
  const closingSides = useRef(new Set<string>());
  const selection = useRef({ conversationId, mainRunning });
  selection.current = { conversationId, mainRunning };
  const { reportStatus } = workspaces;
  /**
   * Publishes the open conversation's live status. Other rows keep the status
   * the server reports, so switching away never blanks their badge.
   */
  const reportTurns = useCallback(
    (turns: readonly Turn[]) => {
      const current = selection.current.conversationId;
      setMainTurns(turns);
      if (current) reportStatus(current, codingConversationStatus(turns));
    },
    [reportStatus],
  );

  const project = projects.find((item) => item.id === projectId);
  const conversation = project
    ? workspaces.conversations[project.id]?.find(
        (item) => item.id === conversationId,
      )
    : undefined;
  const currentSides =
    conversation && conversation.archivedAt === undefined
      ? conversationSides(conversation)
      : [];
  const toolKey = `${endpoint}:${projectId ?? ""}`;
  const tabs = workspaceToolTabs(currentSides, terminals.current);
  const activeToolId = selectedToolId(tabs, toolSelections[toolKey]);
  const sideVisible =
    !!project &&
    toolVisibility[toolKey] !== false &&
    (toolVisibility[toolKey] === true || tabs.length > 0);
  const selectTool = (id: string) =>
    setToolSelections((current) => ({ ...current, [toolKey]: id }));
  const title = conversation?.title ?? legacy?.title ?? "新对话";
  const offline = provider === "offline";
  const refresh = useCallback(() => {
    if (project) void refreshConversations(project.id).catch(() => {});
  }, [project, refreshConversations]);
  const initialSend =
    handoff &&
    project &&
    (!handoff.projectId || project.id === handoff.projectId)
      ? handoff
      : undefined;
  const mode = providerMode(provider);
  const source = Object.values(workspaces.conversations)
    .flat()
    .find(
      (item) =>
        item.id === (workspaces.branchFrom ?? conversation?.sourceSessionId),
    );
  const configKey = conversationId ?? `draft:${projectId}`;
  const modelConfig =
    initialSend?.modelConfig ??
    conversation?.modelConfig?.[mode] ??
    modelConfigs[configKey]?.[mode] ??
    legacy?.modelConfig?.[mode] ??
    source?.modelConfig?.[mode] ??
    {};
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

  const openSide = async () => {
    if (!conversation || openingSide) return;
    setOpeningSide(true);
    setToolVisibility((current) => ({ ...current, [toolKey]: true }));
    try {
      const id = await workspaces.openSide(
        conversation.projectId,
        conversation.id,
      );
      selectTool(id);
    } catch {
      // The controller keeps the service error visible above the transcript.
    } finally {
      setOpeningSide(false);
    }
  };

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
    setToolVisibility((current) => ({ ...current, [toolKey]: true }));
    const info = await terminals.create();
    if (info) selectTool(info.id);
  };
  const closeTool = async (tab: WorkspaceToolTab) => {
    if (!project || closingTools.includes(tab.id)) return;
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
            return (
              <SideConversation
                key={sessionId}
                endpoint={endpoint}
                provider={provider}
                project={space}
                parentId={parent.id}
                sessionId={sessionId}
                title={side.title}
                visible={
                  visible &&
                  sideVisible &&
                  parent.id === conversationId &&
                  sessionId === activeToolId
                }
                modelConfig={
                  side.modelConfig?.[mode] ?? parent.modelConfig?.[mode] ?? {}
                }
                onModelConfig={(selection) => changeModel(sessionId, selection)}
                onProvider={onProvider}
                onSendBack={sendBack}
                onSettled={() =>
                  void refreshConversations(space.id).catch(() => {})
                }
              />
            );
          })
        : [];
    }),
  );

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
      {project ? (
        <WorkbenchMenu
          label="切换对话视图"
          className="coding-view-control"
          items={[
            { id: "chat", label: "对话", action: () => setView("chat") },
            {
              id: "trajectory",
              label: "执行记录",
              action: () => setView("trajectory"),
            },
          ]}
        >
          {view === "chat" ? "对话" : "执行记录"}
          <ChevronDown size={12} />
        </WorkbenchMenu>
      ) : null}
      {headerActions}
      {project ? (
        <button
          ref={sideToggle}
          type="button"
          className="icon-control"
          aria-label="工具面板"
          aria-expanded={sideVisible}
          title={sideVisible ? "收起工具面板" : "打开工具面板"}
          onClick={() =>
            setToolVisibility((current) => ({
              ...current,
              [toolKey]: !sideVisible,
            }))
          }
        >
          <PanelRight size={16} />
        </button>
      ) : null}
    </header>
  );

  return (
    <section
      className={`coding-studio chat-screen studio-main${sideVisible ? " with-side" : ""}`}
      aria-label="工作空间对话"
    >
      {!project ? mainHeader : null}
      {workspaces.error ? (
        <p className="coding-notice" role="alert">
          {workspaces.error}
        </p>
      ) : null}
      {workspaces.branchFrom ? (
        <p className="coding-notice">
          将继承来源对话的上下文，在「{project?.title}」中继续。
        </p>
      ) : null}
      {!project ? (
        <div className="studio-scroll coding-transcript">
          <div className="coding-empty">
            <p>
              工作空间对应一个本机目录：在里面读写代码、运行命令，并把过程实时展示给你。
            </p>
            <button onClick={() => setCreating(true)}>
              <FolderPlus size={15} />
              新建工作空间
            </button>
          </div>
        </div>
      ) : (
        <>
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
                onClose={(tab) => void closeTool(tab)}
                onHide={() => {
                  setToolVisibility((current) => ({
                    ...current,
                    [toolKey]: false,
                  }));
                  sideToggle.current?.focus();
                }}
              />
            }
            main={
              <>
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
                    provider={provider}
                    projectId={project.id}
                    directory={project.directory}
                    label="工作空间请求输入框"
                    {...(conversationId ? { sessionId: conversationId } : {})}
                    readOnly={
                      conversation?.archivedAt !== undefined ||
                      legacy?.archivedAt !== undefined
                    }
                    placeholder={
                      project.isDefault
                        ? "描述你想讨论或完成的事情…"
                        : `在「${project.title}」中描述要完成的事情…`
                    }
                    branchFrom={workspaces.branchFrom}
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
                    onRunFlow={onRunFlow}
                    composerExtra={
                      <div className="composer-workspace">
                        <label className="provider-select composer-workspace-select">
                          <select
                            aria-label="选择工作空间"
                            value={project.id}
                            disabled={mainRunning}
                            onChange={(event) => {
                              if (legacy) workspaces.select(event.target.value);
                              else workspaces.continueIn(event.target.value);
                            }}
                          >
                            {projects.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.title}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    }
                    {...(offline
                      ? {
                          footnote:
                            "工作空间需要连接 Aura 服务，请切换到 Codex 订阅或其他模式",
                        }
                      : {})}
                    onOpen={(id) => {
                      if (id !== configKey)
                        setModelConfigs((current) => {
                          const next = {
                            ...current,
                            [id]: {
                              ...current[configKey],
                              [mode]: modelConfig,
                            },
                          };
                          delete next[configKey];
                          return next;
                        });
                      open(project.id, id);
                      onOpened?.();
                    }}
                    onSettled={refresh}
                    onProvider={onProvider}
                    modelConfig={modelConfig}
                    onModelConfig={(selection) =>
                      changeModel(configKey, selection)
                    }
                    {...(initialSend ? { initialSend } : {})}
                    {...(onHandoffTaken
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
                  </div>
                ) : null}
                {sides}
                {terminals.all.map((info) => (
                  <TerminalPane
                    key={`${endpoint}:${info.id}`}
                    endpoint={endpoint}
                    info={info}
                    visible={
                      info.projectId === project.id && info.id === activeToolId
                    }
                    onInfo={terminals.update}
                  />
                ))}
              </>
            }
            sideVisible={sideVisible}
          />
        </>
      )}
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
