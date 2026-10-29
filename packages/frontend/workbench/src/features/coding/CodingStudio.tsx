import React, { useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, FolderPlus, GitBranch, LoaderCircle } from "lucide-react";
import type { ChatImage, Session, Workspace } from "@aura/core/types";
import { providerMode } from "@aura/core";
import type {
  ChatModelSelection,
  FlowMode,
  FlowCatalogEntry,
} from "@aura/protocol/types";
import { chatHistory } from "../../workflowSessions";
import { ConversationPane, type ConversationSend } from "./ConversationPane";
import { ConversationSplit } from "./ConversationSplit";
import { SideConversation } from "./SideConversation";
import { codingConversationStatus } from "./conversationStatus";
import type { CodingProjectsController } from "./useCodingProjects";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { Turn } from "./turns";
import "./coding.css";

export type CodingHandoff = {
  id: string;
  projectId?: string;
  prompt: string;
  /** Images already uploaded on the chat page. */
  images?: ChatImage[];
  modelConfig?: ChatModelSelection;
};

/** The selected workspace conversation and its durable, per-parent side chat. */
export function CodingStudio({
  endpoint,
  provider,
  workspaces,
  handoff,
  onHandoffTaken,
  onProvider,
  onBack,
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
  provider: Workspace["provider"];
  /** Workspace tree state shared with the sidebar. */
  workspaces: CodingProjectsController;
  /** A first request started from the chat page in a chosen workspace. */
  handoff?: CodingHandoff;
  onHandoffTaken?(): void;
  onProvider(provider: Workspace["provider"]): void;
  onBack(): void;
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
  const [mainRunning, setMainRunning] = useState(false);
  const [modelConfigs, setModelConfigs] = useState<
    Record<string, Partial<Record<FlowMode, ChatModelSelection>>>
  >({});
  const mainSend = useRef<ConversationSend | undefined>(undefined);
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
  const sideId = conversation?.sideSessionId;
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
    try {
      await workspaces.openSide(conversation.projectId, conversation.id);
    } catch {
      // The controller keeps the service error visible above the transcript.
    } finally {
      setOpeningSide(false);
    }
  };

  const sendBack = useCallback((parentId: string, summary: string) => {
    if (
      selection.current.conversationId !== parentId ||
      selection.current.mainRunning ||
      !mainSend.current
    )
      return false;
    void mainSend.current(`以下是旁支对话的总结，供参考：\n\n${summary}`, []);
    return true;
  }, []);

  // Navigation only hides a side; explicit closure or parent archival removes it.
  const sides = projects.flatMap((space) =>
    (workspaces.conversations[space.id] ?? []).flatMap((parent) => {
      const sessionId = parent.sideSessionId;
      return sessionId && parent.archivedAt === undefined
        ? [
            <SideConversation
              key={sessionId}
              endpoint={endpoint}
              provider={provider}
              project={space}
              parentId={parent.id}
              sessionId={sessionId}
              visible={sessionId === sideId}
              mainRunning={mainRunning}
              modelConfig={
                parent.sideModelConfig?.[mode] ??
                parent.modelConfig?.[mode] ??
                {}
              }
              onModelConfig={(selection) => changeModel(sessionId, selection)}
              onProvider={onProvider}
              onSendBack={sendBack}
              onClose={() => workspaces.closeSide(space.id, sessionId)}
            />,
          ]
        : [];
    }),
  );

  return (
    <section
      className={`coding-studio chat-screen studio-main${sideId ? " with-side" : ""}`}
      aria-label="工作空间对话"
    >
      <header className="studio-toolbar">
        <button
          className="icon-control studio-back"
          aria-label="返回对话"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <div className="studio-title">
          <strong>
            {project
              ? conversation
                ? conversation.title
                : `${project.title} · 新对话`
              : "对话"}
          </strong>
          <span title={project?.directory}>
            {project ? project.directory : "正在读取工作空间…"}
          </span>
        </div>
        {project &&
        conversation &&
        conversation.archivedAt === undefined &&
        !sideId ? (
          <div className="studio-toolbar-actions">
            <button
              className="coding-side-open"
              title="另开一段对话，继承当前对话的上下文，不打断主对话"
              disabled={offline || openingSide}
              onClick={() => void openSide()}
            >
              {openingSide ? (
                <LoaderCircle size={14} className="coding-spin" />
              ) : (
                <GitBranch size={14} />
              )}
              旁支对话
            </button>
          </div>
        ) : null}
      </header>
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
        <ConversationSplit
          main={
            <ConversationPane
              endpoint={endpoint}
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
                      [id]: { ...current[configKey], [mode]: modelConfig },
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
              onModelConfig={(selection) => changeModel(configKey, selection)}
              {...(initialSend ? { initialSend } : {})}
              {...(onHandoffTaken
                ? { onInitialSendTaken: onHandoffTaken }
                : {})}
              sendRef={mainSend}
              onRunning={setMainRunning}
              onTurns={reportTurns}
            />
          }
          side={sides.length ? sides : undefined}
          sideVisible={!!sideId}
        />
      )}
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
