import React, { useEffect, useRef, useState } from "react";
import { CornerUpLeft } from "lucide-react";
import type { Workspace } from "@aura/core/types";
import type {
  ChatModelSelection,
  CodingProjectInfo,
} from "@aura/protocol/types";
import { ConversationPane } from "./ConversationPane";
import { fileDiff } from "./diff";
import { handoffPrompt, type Turn } from "./turns";

/** Live turns survive hiding; idle panes can be released without losing drafts. */
export function SideConversation({
  endpoint,
  provider,
  project,
  parentId,
  sessionId,
  title,
  visible,
  modelConfig,
  onModelConfig,
  onProvider,
  onSendBack,
  onSettled,
}: {
  endpoint: string;
  provider: Workspace["provider"];
  project: CodingProjectInfo;
  parentId: string;
  sessionId: string;
  title: string;
  visible: boolean;
  modelConfig: ChatModelSelection;
  onModelConfig(selection: ChatModelSelection): void;
  onProvider(provider: Workspace["provider"]): void;
  /** Refuses a handoff if the selected main conversation changed meanwhile. */
  onSendBack(parentId: string, sessionId: string, summary: string): boolean;
  onSettled(): void;
}) {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(visible);
  const [attachments, setAttachments] = useState(false);
  const draft = useRef("");
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (running || attachments) return;
    const timer = setTimeout(() => {
      setMounted(false);
      setTurns([]);
    }, 60_000);
    return () => clearTimeout(timer);
  }, [visible, running, attachments]);

  const sendBack = () => {
    setError("");
    try {
      const summary = handoffPrompt(turns, fileDiff);
      if (!onSendBack(parentId, sessionId, summary))
        throw new Error("主对话已切换或侧边对话正在关闭，暂未带回结论。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handoff = (
    <button
      type="button"
      className="coding-side-handoff"
      disabled={!turns.length || running || !visible}
      title="将已有结论放入主对话草稿，确认后再发送"
      onClick={sendBack}
    >
      <CornerUpLeft size={13} />
      带回主对话
    </button>
  );

  return (
    <section
      className="coding-side-conversation coding-pane"
      id={`tool-panel-${sessionId}`}
      role="tabpanel"
      aria-labelledby={`tool-tab-${sessionId}`}
      aria-label={title}
      hidden={!visible}
    >
      {error ? (
        <p className="coding-notice" role="alert">
          {error}
        </p>
      ) : null}
      {mounted ? (
        <ConversationPane
          endpoint={endpoint}
          visible={visible}
          provider={provider}
          projectId={project.id}
          directory={project.directory}
          label="侧边对话输入框"
          sessionId={sessionId}
          forkFrom={parentId}
          initialDraft={draft.current}
          onDraftChange={(value) => {
            draft.current = value;
          }}
          onAttachmentsChange={setAttachments}
          placeholder="基于主对话继续问，不会打断它…"
          onProvider={onProvider}
          modelConfig={modelConfig}
          onModelConfig={onModelConfig}
          composerExtra={<div className="coding-side-actions">{handoff}</div>}
          onRunning={setRunning}
          onTurns={setTurns}
          onSettled={onSettled}
        />
      ) : null}
    </section>
  );
}
