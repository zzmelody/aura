import React, { useRef, useState } from "react";
import { GitBranch, LoaderCircle, Send, X } from "lucide-react";
import type { Workspace } from "@aura/core/types";
import type {
  ChatModelSelection,
  CodingProjectInfo,
} from "@aura/protocol/types";
import { ConversationPane, type ConversationSend } from "./ConversationPane";
import { diffLines, diffStats } from "./diff";
import { handoffPrompt, type Turn } from "./turns";

const SUMMARY_REQUEST =
  "请总结这段旁支对话：结论、做过的改动和还没解决的问题。只写总结，不要再调用工具。";

/** Kept mounted when hidden so switching parents does not stop its live turn. */
export function SideConversation({
  endpoint,
  provider,
  project,
  parentId,
  sessionId,
  visible,
  mainRunning,
  modelConfig,
  onModelConfig,
  onProvider,
  onSendBack,
  onClose,
}: {
  endpoint: string;
  provider: Workspace["provider"];
  project: CodingProjectInfo;
  parentId: string;
  sessionId: string;
  visible: boolean;
  mainRunning: boolean;
  modelConfig: ChatModelSelection;
  onModelConfig(selection: ChatModelSelection): void;
  onProvider(provider: Workspace["provider"]): void;
  /** Refuses a handoff if the selected main conversation changed meanwhile. */
  onSendBack(parentId: string, summary: string): boolean;
  onClose(): Promise<void>;
}) {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [handing, setHanding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const send = useRef<ConversationSend | undefined>(undefined);

  const close = async () => {
    setClosing(true);
    setError("");
    try {
      await onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setClosing(false);
    }
  };
  const sendBack = async () => {
    if (handing || closing) return;
    setHanding(true);
    setError("");
    try {
      const turn = await send.current?.(SUMMARY_REQUEST, []);
      const summary =
        turn?.status === "complete" && turn.reply.trim()
          ? turn.reply.trim()
          : handoffPrompt(turns, (diff) =>
              diffStats(diffLines(diff.oldText, diff.newText)),
            );
      if (!onSendBack(parentId, summary))
        throw new Error(
          "主对话已切换或正在执行，请回到原会话后重试。旁支已保留。",
        );
      await onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHanding(false);
    }
  };

  return (
    <aside className="coding-side" aria-label="旁支对话" hidden={!visible}>
      <header className="coding-side-header">
        <GitBranch size={14} />
        <strong>旁支对话</strong>
        <span>切换会话、重启后保留，主动关闭或主对话关闭、归档后丢弃</span>
        <button
          className="coding-side-handoff"
          disabled={
            !turns.length ||
            running ||
            handing ||
            closing ||
            mainRunning ||
            !visible
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
          disabled={handing || closing}
          onClick={() => void close()}
        >
          <X size={15} />
        </button>
      </header>
      {error ? (
        <p className="coding-notice" role="alert">
          {error}
        </p>
      ) : null}
      <ConversationPane
        endpoint={endpoint}
        provider={provider}
        projectId={project.id}
        directory={project.directory}
        label="旁支对话输入框"
        sessionId={sessionId}
        forkFrom={parentId}
        placeholder="问点别的，不会打断主对话…"
        empty={
          <p>旁支对话带着主对话的上下文，拥有同样的工具，可以读写这个目录。</p>
        }
        onProvider={onProvider}
        modelConfig={modelConfig}
        onModelConfig={onModelConfig}
        sendRef={send}
        onRunning={setRunning}
        onTurns={setTurns}
      />
    </aside>
  );
}
