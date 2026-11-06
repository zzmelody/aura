import React, { useEffect, useRef, useState } from "react";
import {
  useConversationMessages,
  conversationMessage as message,
} from "../../conversation-messages.ts";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import { CornerUpLeft } from "lucide-react";
import type { Workspace } from "@aura/core/types";
import type {
  ChatModelSelection,
  CodingPermission,
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
  permission,
  permissionSaving,
  onPermission,
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
  permission?: CodingPermission;
  permissionSaving: boolean;
  onPermission(permission: CodingPermission): Promise<void>;
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
  const { t, i18n } = useConversationMessages();
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | MessageReference>("");
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

  const deliver = (summary: string, notice: string | MessageReference = "") => {
    if (!onSendBack(parentId, sessionId, summary)) {
      setError(message("handoffRetained"));
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
        result.kind === "fallback" ? message("handoffFallback") : "",
      );
    } catch (reason) {
      setError(errorMessage(reason));
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
      title={t("handoffHint")}
      onClick={() => void sendBack()}
    >
      <CornerUpLeft size={13} />
      {summarizing ? t("summarizingHandoff") : t("returnMain")}
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
          {messageText(error, i18n)}
        </p>
      ) : null}
      {mounted ? (
        <ConversationPane
          endpoint={endpoint}
          visible={visible}
          provider={provider}
          projectId={project.id}
          directory={project.directory}
          label={t("sideInput")}
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
          placeholder={t("sidePlaceholder")}
          onProvider={onProvider}
          modelConfig={modelConfig}
          onModelConfig={onModelConfig}
          permission={permission}
          permissionSaving={permissionSaving}
          onPermission={onPermission}
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
