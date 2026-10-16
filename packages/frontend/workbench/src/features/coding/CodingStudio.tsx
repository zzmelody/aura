import React, { useCallback, useRef, useState } from "react";
import { ArrowLeft, FolderPlus, GitBranch, LoaderCircle } from "lucide-react";
import type { ChatImage, Workspace } from "@aura/core/types";
import type { ChatModelSelection } from "@aura/protocol/types";
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
  projectId: string;
  prompt: string;
  /** Images already uploaded on the chat page. */
  images?: ChatImage[];
};

/** The selected workspace conversation and its durable, per-parent side chat. */
export function CodingStudio({
  endpoint,
  provider,
  workspaces,
  handoff,
  onHandoffTaken,
  modelConfig,
  onModelConfig,
  onProvider,
  onBack,
}: {
  endpoint: string;
  provider: Workspace["provider"];
  /** Workspace tree state shared with the sidebar. */
  workspaces: CodingProjectsController;
  /** A first request started from the chat page in a chosen workspace. */
  handoff?: CodingHandoff;
  onHandoffTaken?(): void;
  /** Model and effort for the current mode, shared with the chat page. */
  modelConfig: ChatModelSelection;
  onModelConfig(selection: ChatModelSelection): void;
  onProvider(provider: Workspace["provider"]): void;
  onBack(): void;
}) {
  const {
    projects,
    selectedId: projectId,
    conversationId,
    open,
    refreshConversations,
  } = workspaces;
  const [creating, setCreating] = useState(false);
  const [openingSide, setOpeningSide] = useState(false);
  const [mainRunning, setMainRunning] = useState(false);
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
    handoff && project?.id === handoff.projectId ? handoff : undefined;

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
              modelConfig={modelConfig}
              onModelConfig={onModelConfig}
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
              : "工作空间"}
          </strong>
          <span title={project?.directory}>
            {project ? project.directory : "在左侧选择或新建一个工作空间"}
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
              // A new workspace or conversation starts a fresh transcript.
              key={project.id}
              endpoint={endpoint}
              provider={provider}
              projectId={project.id}
              directory={project.directory}
              label="工作空间请求输入框"
              {...(conversationId ? { sessionId: conversationId } : {})}
              readOnly={conversation?.archivedAt !== undefined}
              placeholder={`在「${project.title}」中描述要完成的事情…`}
              empty={
                <p>
                  {conversationId
                    ? "这段对话还没有记录，可以继续发送新的请求。"
                    : `描述你要在「${project.title}」里完成的事情。改动只会写入这个目录。`}
                </p>
              }
              footnote={
                offline
                  ? "工作空间需要连接 Aura 服务，请切换到 Codex 订阅或其他模式"
                  : `可读写文件、运行命令 · ${project.directory}`
              }
              onOpen={(id) => open(project.id, id)}
              onSettled={refresh}
              onProvider={onProvider}
              modelConfig={modelConfig}
              onModelConfig={onModelConfig}
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
