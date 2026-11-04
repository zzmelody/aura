import React, { useEffect, useRef, useState } from "react";
import { CornerUpLeft } from "lucide-react";
import type { Workspace } from "@aura/core/types";
import type {
  ChatModelSelection,
  CodingProjectInfo,
  FlowCatalogEntry,
} from "@aura/protocol/types";
import { ConversationPane, type ConversationSend } from "./ConversationPane";
import { fileDiff } from "./diff";
import {
  HANDOFF_SUMMARY_PROMPT,
  handoffResult,
  reusableHandoffSummary,
  type Turn,
} from "./turns";

/** Live turns survive hiding; idle panes can be released without losing drafts. */
export function SideConversation({
  endpoint,
  provider,
  project,
  parentId,
  sessionId,
  title,
  selected,
  visible,
  modelConfig,
  onModelConfig,
  onProvider,
  onSendBack,
  onSettled,
  onForkTurn,
  draftInsert,
  onRunning,
  flows,
  flowsLoading,
}: {
  endpoint: string;
  provider: Workspace["provider"];
  project: CodingProjectInfo;
  parentId: string;
  sessionId: string;
  title: string;
  selected: boolean;
  visible: boolean;
  modelConfig: ChatModelSelection;
  onModelConfig(selection: ChatModelSelection): void;
  onProvider(provider: Workspace["provider"]): void;
  /** Refuses a handoff if the selected main conversation changed meanwhile. */
  onSendBack(parentId: string, sessionId: string, summary: string): boolean;
  onSettled(): void;
  onForkTurn?(endSeq: number): void;
  /** Text appended to this side chat's draft, e.g. a quoted selection. */
  draftInsert?: { id: string; text: string };
  /** Reports whether this side chat has a live turn, for the parent's badge. */
  onRunning?(sessionId: string, running: boolean): void;
  flows?: FlowCatalogEntry[];
  flowsLoading?: boolean;
}) {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(visible);
  const [attachments, setAttachments] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const draft = useRef("");
  const send = useRef<ConversationSend | undefined>(undefined);
  // The summary turn settles after an await; read the turns as they are then.
  const latestTurns = useRef(turns);
  latestTurns.current = turns;
  // The saved draft already contains inserts taken before a release, so a
  // remounted pane must not apply the same insert again.
  const latestInsert = useRef(draftInsert);
  latestInsert.current = draftInsert;
  const releasedInsert = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (running || attachments) return;
    const timer = setTimeout(() => {
      releasedInsert.current = latestInsert.current?.id;
      setMounted(false);
      setTurns([]);
    }, 60_000);
    return () => clearTimeout(timer);
  }, [visible, running, attachments]);
  useEffect(
    () => onRunning?.(sessionId, running),
    [onRunning, sessionId, running],
  );
  // A closed side chat no longer keeps its parent running.
  useEffect(() => () => onRunning?.(sessionId, false), [onRunning, sessionId]);

  const deliver = (summary: string, notice = "") => {
    if (!onSendBack(parentId, sessionId, summary)) {
      setError(
        "主对话已切换或侧边对话正在关闭，结论保留在侧边对话中，可稍后再带回。",
      );
      return;
    }
    setError(notice);
  };

  /**
   * Asks the side chat's model to summarize itself, then puts that summary in
   * the main draft. A finished summary is reused; failures fall back to the
   * deterministic recap, and stopping the turn cancels the hand-off.
   */
  const sendBack = async () => {
    if (summarizing) return;
    setError("");
    const reused = reusableHandoffSummary(turns);
    if (reused) {
      deliver(reused);
      return;
    }
    setSummarizing(true);
    try {
      // Keep whatever the user was typing in the side composer.
      const turn = await send.current?.(HANDOFF_SUMMARY_PROMPT, [], {
        preserveDraft: true,
      });
      const result = handoffResult(turn, latestTurns.current, fileDiff);
      if (result.kind === "cancelled") return;
      deliver(
        result.text,
        result.kind === "fallback" ? "总结失败，已改用简要结论。" : "",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSummarizing(false);
    }
  };

  const handoff = (
    <button
      type="button"
      className="coding-side-handoff"
      disabled={!turns.length || running || summarizing || !visible}
      aria-busy={summarizing || undefined}
      title="让侧边对话整理交接结论，放入主对话草稿，确认后再发送"
      onClick={() => void sendBack()}
    >
      <CornerUpLeft size={13} />
      {summarizing ? "正在整理结论…" : "带回主对话"}
    </button>
  );

  return (
    <section
      className="coding-side-conversation coding-pane"
      id={`tool-panel-${sessionId}`}
      role="tabpanel"
      aria-labelledby={`tool-tab-${sessionId}`}
      aria-label={title}
      hidden={!selected}
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
          onForkTurn={onForkTurn}
          initialDraft={draft.current}
          onDraftChange={(value) => {
            draft.current = value;
          }}
          onAttachmentsChange={setAttachments}
          draftInsert={
            draftInsert && draftInsert.id !== releasedInsert.current
              ? draftInsert
              : undefined
          }
          placeholder="基于主对话继续问，不会打断它…"
          onProvider={onProvider}
          modelConfig={modelConfig}
          onModelConfig={onModelConfig}
          sendRef={send}
          composerExtra={<div className="coding-side-actions">{handoff}</div>}
          onRunning={setRunning}
          onTurns={setTurns}
          onSettled={onSettled}
          flows={flows}
          flowsLoading={flowsLoading}
        />
      ) : null}
    </section>
  );
}
