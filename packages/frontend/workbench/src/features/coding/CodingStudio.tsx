import React, { useCallback, useRef, useState } from "react";
import {
  ArrowLeft,
  FolderPlus,
  GitBranch,
  LoaderCircle,
  Send,
  X,
} from "lucide-react";
import { providerMode } from "@aura/core";
import type { ChatImage, Workspace } from "@aura/core/types";
import type { ChatModelSelection } from "@aura/protocol/types";
import { closeSideChat } from "./api";
import { ConversationPane, type ConversationSend } from "./ConversationPane";
import { diffLines, diffStats } from "./diff";
import { handoffPrompt, type Turn } from "./turns";
import type { CodingProjectsController } from "./useCodingProjects";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "./coding.css";

export type CodingHandoff = {
  id: string;
  projectId: string;
  prompt: string;
  /** Images already uploaded on the chat page. */
  images?: ChatImage[];
};

/** Asked of the side chat before its conclusion goes back to the main one. */
const SUMMARY_REQUEST =
  "请总结这段旁支对话：结论、做过的改动和还没解决的问题。只写总结，不要再调用工具。";

const countLines = (diff: { oldText: string | null; newText: string }) =>
  diffStats(diffLines(diff.oldText, diff.newText));

/** A side chat open next to the main conversation. */
type Side = {
  /** Remounts the pane, so each side chat starts empty. */
  key: number;
  /** Conversation it branches from. */
  parentId: string;
  /** Its own session, known after the first send. */
  sessionId?: string;
};

/**
 * The open workspace conversation. Workspaces and their conversations are
 * listed in the sidebar tree, so this page only shows the transcript and the
 * composer for the selection held by `workspaces`. A side chat can be opened
 * beside it: it forks the conversation, runs with the same tools, and is
 * discarded when closed, optionally after sending its summary back.
 */
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
  const [side, setSide] = useState<Side | undefined>();
  const [sideTurns, setSideTurns] = useState<readonly Turn[]>([]);
  const [sideRunning, setSideRunning] = useState(false);
  const [mainRunning, setMainRunning] = useState(false);
  const [handing, setHanding] = useState(false);
  const [sideError, setSideError] = useState("");
  const mainSend = useRef<ConversationSend | undefined>(undefined);
  const sideSend = useRef<ConversationSend | undefined>(undefined);
  const nextSide = useRef(0);

  const project = projects.find((item) => item.id === projectId);
  const conversation = project
    ? workspaces.conversations[project.id]?.find(
        (item) => item.id === conversationId,
      )
    : undefined;
  const mode = providerMode(provider);
  const offline = provider === "offline";
  const refresh = useCallback(() => {
    if (project) void refreshConversations(project.id).catch(() => {});
  }, [project, refreshConversations]);
  const initialSend =
    handoff && project?.id === handoff.projectId ? handoff : undefined;

  /** Discards the side chat on the backend; the panel closes either way. */
  const discardSide = useCallback(
    async (current: Side | undefined) => {
      setSide(undefined);
      setSideTurns([]);
      setSideError("");
      if (current?.sessionId)
        await closeSideChat(endpoint, current.sessionId).catch(() => {});
    },
    [endpoint],
  );

  // A side chat belongs to one conversation; switching away discards it.
  const sideParent = side?.parentId;
  const [lastConversation, setLastConversation] = useState(conversationId);
  if (lastConversation !== conversationId) {
    setLastConversation(conversationId);
    if (side && sideParent !== conversationId) void discardSide(side);
  }

  const openSide = () => {
    if (!conversation) return;
    nextSide.current += 1;
    setSide({ key: nextSide.current, parentId: conversation.id });
    setSideTurns([]);
    setSideError("");
  };

  /**
   * Asks the side chat for a summary, sends it to the main conversation as a
   * normal request, then discards the side chat.
   */
  const sendBack = async () => {
    if (!side || handing) return;
    setHanding(true);
    setSideError("");
    try {
      const summaryTurn = await sideSend.current?.(SUMMARY_REQUEST, []);
      const summary =
        summaryTurn?.status === "complete" && summaryTurn.reply.trim()
          ? summaryTurn.reply.trim()
          : handoffPrompt(sideTurns, countLines);
      const current = side;
      await discardSide(current);
      void mainSend.current?.(
        `以下是旁支对话的总结，供参考：\n\n${summary}`,
        [],
      );
    } catch (reason) {
      setSideError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHanding(false);
    }
  };

  const sideHasWork = sideTurns.length > 0;

  return (
    <section
      className={`coding-studio chat-screen studio-main${side ? " with-side" : ""}`}
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
        {project && conversation && !side ? (
          <div className="studio-toolbar-actions">
            <button
              className="coding-side-open"
              title="另开一段对话，继承当前对话的上下文，不打断主对话"
              disabled={offline}
              onClick={openSide}
            >
              <GitBranch size={14} />
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
        <div className="coding-panes">
          <ConversationPane
            // A new workspace or conversation starts a fresh transcript.
            key={project.id}
            endpoint={endpoint}
            provider={provider}
            projectId={project.id}
            directory={project.directory}
            label="工作空间请求输入框"
            {...(conversationId ? { sessionId: conversationId } : {})}
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
                ? "工作空间需要连接 Aura 服务，请切换到 DSH 演示或其他模式"
                : mode === "demo"
                  ? `演示模式 · 未调用真实 AI · ${project.directory}`
                  : `可读写文件、运行命令 · ${project.directory}`
            }
            onOpen={(id) => open(project.id, id)}
            onSettled={refresh}
            onProvider={onProvider}
            modelConfig={modelConfig}
            onModelConfig={onModelConfig}
            {...(initialSend ? { initialSend } : {})}
            {...(onHandoffTaken ? { onInitialSendTaken: onHandoffTaken } : {})}
            sendRef={mainSend}
            onRunning={setMainRunning}
          />
          {side ? (
            <aside className="coding-side" aria-label="旁支对话">
              <header className="coding-side-header">
                <GitBranch size={14} />
                <strong>旁支对话</strong>
                <span>继承主对话到最近一轮，关闭后不保留</span>
                <button
                  className="coding-side-handoff"
                  disabled={
                    !sideHasWork || sideRunning || handing || mainRunning
                  }
                  title={
                    mainRunning
                      ? "主对话正在进行，等它结束后再发送"
                      : "让旁支总结结论，发给主对话，然后关闭旁支"
                  }
                  onClick={() => void sendBack()}
                >
                  {handing ? (
                    <LoaderCircle size={13} className="coding-spin" />
                  ) : (
                    <Send size={13} />
                  )}
                  总结并发给主对话
                </button>
                <button
                  className="icon-control"
                  aria-label="关闭旁支对话"
                  title="关闭并丢弃旁支对话"
                  disabled={handing}
                  onClick={() => void discardSide(side)}
                >
                  <X size={15} />
                </button>
              </header>
              {sideError ? (
                <p className="coding-notice" role="alert">
                  {sideError}
                </p>
              ) : null}
              <ConversationPane
                key={side.key}
                endpoint={endpoint}
                provider={provider}
                projectId={project.id}
                directory={project.directory}
                label="旁支对话输入框"
                {...(side.sessionId ? { sessionId: side.sessionId } : {})}
                forkFrom={side.parentId}
                placeholder="问点别的，不会打断主对话…"
                empty={
                  <p>
                    旁支对话带着主对话的上下文，拥有同样的工具，可以读写这个目录。
                  </p>
                }
                onOpen={(id) =>
                  setSide((current) =>
                    current && current.key === side.key
                      ? { ...current, sessionId: id }
                      : current,
                  )
                }
                onProvider={onProvider}
                modelConfig={modelConfig}
                onModelConfig={onModelConfig}
                sendRef={sideSend}
                onRunning={setSideRunning}
                onTurns={setSideTurns}
              />
            </aside>
          ) : null}
        </div>
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
