import { nativeCall } from "../../native-messages.ts";
import { apiErrorText } from "../../api-error-messages.ts";
import { flowTitle } from "../../metadata.ts";
import {
  useConversationMessages,
  conversationMessage as message,
  conversationText,
  type ConversationMessageKey,
} from "../../conversation-messages.ts";
import {
  formatNumber,
  language,
  MessageError,
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import { conversations } from "./conversation-store.ts";
import { useConversation } from "./useConversation.ts";
import { isExecutionActive } from "@aura/protocol/conversation-channel";
import { MaskedUserText } from "./MaskedUserText.tsx";
import {
  changeCodingCollaboration,
  compactCoding,
  readCodingCollaboration,
} from "./api.ts";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from "react";
import { legacyConversationTurns } from "@aura/protocol/conversations";
import { extractFlowCode } from "../../flowDraft";
import { NestedFlowRun } from "../../screens/WorkflowRun";
import { schemaInitialValue } from "../../screens/WorkflowInput";
import { WorkflowRunForm } from "../../screens/WorkflowRunForm";
import {
  flowConversationPrompt,
  type FlowConversationRequest,
} from "../../flow-conversation";
import { ComposerCommands, useComposerCommands } from "./ComposerCommands";
import { ComposerEditor } from "./ComposerEditor";
import { collaborationCommand } from "./composer-commands";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleStop,
  CircleX,
  ClipboardCheck,
  Copy,
  File as FileIcon,
  FileArchive,
  FileBraces,
  FileCode,
  FileCodeCorner,
  FileDiff,
  FileImage,
  FileLock,
  FileMusic,
  FilePen,
  FilePlus,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
  FolderSearch,
  Palette,
  Image as ImageIcon,
  ImagePlus,
  Plus,
  ListTodo,
  LoaderCircle,
  PackageCheck,
  Search,
  Square,
  Terminal,
  Target,
  SquareTerminal,
  MessageCircleQuestion,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  ShieldX,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { providerMode } from "@aura/core";
import { CODING_PERMISSIONS } from "@aura/protocol";
import type { Workspace } from "@aura/core/types";
import type {
  ChatModelSelection,
  ChatMessage,
  CodingCollaboration,
  CodingCollaborationAction,
  CodingRunIntent,
  FlowCatalogEntry,
  FlowRun,
  FlowMode,
  CodingFileDiff,
  CodingHistoryTurn,
  CodingPermission,
  CodingQuestionAnswer,
} from "@aura/protocol/types";
import { WorkflowRichText } from "../../screens/WorkflowValue";
import { ChatModelControls } from "../../screens/ChatModelControls";
import { modelCatalogs } from "../../model-catalog-store";
import { WorkbenchMenu } from "../../WorkbenchMenu";
import { TurnActions } from "./TurnActions.tsx";
import "./composer.css";
import { VoiceInput } from "./VoiceInput.tsx";
import { useIntegrations } from "../../integrations.tsx";
import { useConversationDraft } from "./useConversationDraft.ts";
import { writeClipboard } from "../../clipboard";
import type { ChatImage } from "@aura/core/types";
import { chatImageUrl } from "../../chatImages";
import { ImageLightbox, ImageThumbnails } from "../../ImageLightbox";
import { pastedImages, useImageAttachments } from "../../useImageAttachments";
import { WorkflowApiError } from "../../workflowSessions";
import {
  conversationHistory,
  stopCodingTurn,
  prepareCodingTurn,
  waitForCodingTurnEnd,
} from "./api";
import { fileDiff } from "./diff";
import { retainConversations } from "./conversation-cache";
import {
  BINARY_KINDS,
  displayPath,
  fileDir,
  fileKind,
  fileName,
  fullPath,
  type FileKind,
} from "./fileKinds";
import {
  addPendingSteer,
  mergeConversationSteers,
  mergeConversationWindow,
  finishTurn,
  newTurn,
  pendingQuestion,
  reconcileFinishedTurn,
  settlePendingSteer,
  summarizeTurn,
  summarizeToolGroup,
  describeToolGroup,
  turnPresentation,
  turnsFromHistory,
  type AskedQuestion,
  type ToolEntry,
  type Turn,
} from "./turns";

type GuidanceState = {
  phase: "sending" | "checking" | "retry" | "ready";
  turnId: string;
};

type ConversationStream = {
  controller: AbortController;
  turnId: string;
  reconcile(recorded: CodingHistoryTurn | undefined, checkedAt: number): void;
};

/** One file-change block inside an expanded step: path header, then lines. */
function DiffCard({ diff }: { diff: CodingFileDiff }) {
  const { t } = useConversationMessages();
  const { lines } = fileDiff(diff);
  return (
    <div className="coding-diff">
      <pre aria-label={t("fileChangesLabel", { path: diff.path })}>
        <span className="coding-diff-path">{diff.path}</span>
        {"\n"}
        {lines.map((line, index) => (
          <span key={index} className={`coding-diff-line ${line.kind}`}>
            <span aria-hidden="true">
              {line.kind === "add"
                ? "+ "
                : line.kind === "remove"
                  ? "- "
                  : "  "}
            </span>
            {line.text || " "}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

const toolIcons: Record<string, LucideIcon> = {
  read: FileText,
  read_image: ImageIcon,
  write: FilePlus,
  edit: FilePen,
  glob: FolderSearch,
  grep: Search,
  bash: SquareTerminal,
  pwsh: SquareTerminal,
  todo_write: ListTodo,
  present: PackageCheck,
  exit_plan_mode: ClipboardCheck,
  get_goal: Target,
  update_goal: Target,
  ask_user_question: MessageCircleQuestion,
};

const toolStates = {
  running: { icon: LoaderCircle, label: "executing" },
  ok: { icon: CircleCheck, label: "completed" },
  failed: { icon: CircleX, label: "failed" },
  stopped: { icon: CircleStop, label: "interrupted" },
} as const;

/** DSH-style tool identity and expandable diff, with an explicit outcome. */
function ToolRow({ tool }: { tool: ToolEntry }) {
  const { t } = useConversationMessages();
  const [open, setOpen] = useState(false);
  const Icon = toolIcons[tool.name] ?? Wrench;
  const title = toolLabels[tool.name] ? t(toolLabels[tool.name]) : tool.name;
  const { icon: StateIcon, label: stateLabel } = toolStates[tool.state];
  const expandable = !!tool.diffs?.length && tool.state !== "running";
  const totals = tool.diffs?.length
    ? tool.diffs.reduce(
        (sum, diff) => {
          const counts = fileDiff(diff);
          return {
            added: sum.added + counts.added,
            removed: sum.removed + counts.removed,
          };
        },
        { added: 0, removed: 0 },
      )
    : undefined;
  const content = (
    <>
      <span className="coding-tool-leading" aria-hidden="true">
        <Icon className="coding-tool-icon" />
        {expandable ? <ChevronRight className="coding-tool-chevron" /> : null}
      </span>
      <span className="coding-tool-title">{title}</span>
      {tool.detail ? (
        <>
          <span className="coding-tool-sep" aria-hidden="true" />
          <span className="coding-tool-summary" title={tool.detail}>
            {tool.detail}
          </span>
        </>
      ) : null}
      {totals && tool.state === "ok" ? (
        <span className="coding-tool-stat">
          <span className="coding-diff-added">
            +{formatNumber(totals.added)}
          </span>{" "}
          <span className="coding-diff-removed">
            -{formatNumber(totals.removed)}
          </span>
        </span>
      ) : null}
      <span className={`coding-tool-state ${tool.state}`}>
        <StateIcon
          size={13}
          className={tool.state === "running" ? "coding-spin" : undefined}
          aria-hidden="true"
        />
        <span>{t(stateLabel)}</span>
      </span>
    </>
  );
  return (
    <li
      className={`coding-tool ${tool.state}`}
      data-tool={tool.name}
      data-open={open || undefined}
    >
      {expandable ? (
        <button
          type="button"
          className="coding-tool-row"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {content}
        </button>
      ) : (
        <div className="coding-tool-row">{content}</div>
      )}
      {expandable && open ? (
        <div className="coding-diffs">
          {tool.diffs!.map((diff, index) => (
            <DiffCard key={index} diff={diff} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

const toolLabels: Record<string, ConversationMessageKey> = {
  read: "readFile",
  read_image: "viewImage",
  write: "writeFile",
  edit: "editFile",
  glob: "findFile",
  grep: "searchContent",
  bash: "runCommand",
  pwsh: "runCommand",
  todo_write: "updateTasks",
  present: "deliverFiles",
  exit_plan_mode: "submitPlan",
  get_goal: "readGoal",
  update_goal: "updateGoal",
  ask_user_question: "askQuestion",
};

function duration(ms: number, locale: string): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const format = (value: number, unit: string) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
    }).format(value);
  if (seconds < 60) return format(seconds, "second");
  return new Intl.ListFormat(locale, { style: "short", type: "unit" }).format([
    format(Math.floor(seconds / 60), "minute"),
    format(seconds % 60, "second"),
  ]);
}

/** One consecutive run stays between the assistant messages that surround it. */
function ToolGroup({
  tools,
  expanded,
  onToggle,
}: {
  tools: ToolEntry[];
  expanded: boolean;
  onToggle(): void;
}) {
  const { t } = useConversationMessages();
  const id = useId();
  const summary = summarizeToolGroup(tools);
  if (!summary.total) return null;
  const description = summary.active
    ? t("toolActive", {
        action: toolLabels[summary.active.name]
          ? t(toolLabels[summary.active.name])
          : t("callTool"),
      })
    : describeToolGroup(tools);
  const Icon = summary.active ? LoaderCircle : Wrench;
  return (
    <section
      className={`coding-tool-group ${summary.state}`}
      aria-label={t("toolGroup")}
      data-coding-process-record
    >
      <button
        type="button"
        className="coding-tool-group-toggle"
        aria-expanded={expanded}
        aria-controls={id}
        title={t(expanded ? "toolGroupExpanded" : "toolGroupCollapsed", {
          description,
          count: summary.total,
        })}
        onClick={onToggle}
      >
        <Icon
          size={15}
          className={summary.state === "running" ? "coding-spin" : undefined}
        />
        <span className="coding-tool-group-title">{description}</span>
        {summary.failed ? (
          <span className="coding-tool-group-failed">
            {t("failedCount", { count: summary.failed })}
          </span>
        ) : null}
        {summary.stopped ? (
          <span className="coding-tool-group-stopped">
            {t("interruptedCount", { count: summary.stopped })}
          </span>
        ) : null}
        <ChevronRight size={12} className="coding-tool-group-chevron" />
      </button>
      <ol
        id={id}
        className="coding-tools"
        aria-label={t("activityLog")}
        hidden={!expanded}
      >
        {expanded
          ? tools.map((tool) => <ToolRow key={tool.callId} tool={tool} />)
          : null}
      </ol>
    </section>
  );
}

/** Allow and reject labels of an approval, as the backend offers them. */
function approvalLabels(asked: AskedQuestion) {
  const options = asked.questions[0]?.options ?? [];
  return {
    allow: options[0]?.label ?? "允许这一次",
    reject: options[1]?.label ?? "拒绝",
  };
}

const SANDBOX_MODE_LABELS: Record<string, ConversationMessageKey> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "fullAccess",
};

/** Picks DSH's localized reason: exact locale, then base language, then English. */
function localizedReason(
  display: Record<string, string> | undefined,
  locale: string,
) {
  if (!display) return undefined;
  const base = locale.split("-")[0]!;
  return display[locale] ?? display[base] ?? display.en;
}

/**
 * Headline and detail of an approval in the interface language. Questions
 * without structured facts (older history) keep the text the backend sent.
 */
function approvalText(
  question: AskedQuestion["questions"][number] | undefined,
  t: ReturnType<typeof useConversationMessages>["t"],
  locale: string,
) {
  const facts = question?.approval;
  if (!question || !facts)
    return { headline: question?.question, detail: question?.detail };
  const headline = t("approvalQuestion", { tool: facts.toolName });
  const display = localizedReason(facts.displayReason, locale);
  if (display) return { headline, detail: display };
  if (facts.escalation) {
    const key = SANDBOX_MODE_LABELS[facts.escalation];
    const mode = key ? t(key) : facts.escalation;
    return {
      headline,
      detail: facts.reason
        ? t("approvalEscalation", { mode, reason: facts.reason })
        : t("approvalEscalationNoReason", { mode }),
    };
  }
  return { headline, detail: facts.reason };
}

/** The transcript trace of one approval request. */
function ApprovalNote({
  asked,
  live,
}: {
  asked: AskedQuestion;
  live: boolean;
}) {
  const { t, i18n } = useConversationMessages();
  const question = asked.questions[0];
  const text = approvalText(question, t, i18n.language);
  const { allow } = approvalLabels(asked);
  const granted = asked.answered?.some((answer) =>
    answer.selected.includes(allow),
  );
  const state = asked.answered
    ? granted
      ? { Icon: ShieldCheck, text: t("allowed"), tone: "" }
      : { Icon: ShieldX, text: t("rejected"), tone: " rejected" }
    : live
      ? { Icon: ShieldAlert, text: t("waitingApproval"), tone: "" }
      : { Icon: ShieldX, text: t("approvalEnded"), tone: " rejected" };
  return (
    <div
      className={`coding-approval-note${state.tone}`}
      title={text.detail ?? text.headline}
    >
      <state.Icon aria-hidden="true" />
      <span>{state.text}</span>
      {question ? <span>· {text.headline}</span> : null}
    </div>
  );
}

/**
 * A pending approval above the composer. Enter allows once and Escape rejects,
 * as in DSH; the user's draft stays editable while the decision is pending.
 */
function ApprovalCard({
  asked,
  active,
  onAnswer,
}: {
  asked: AskedQuestion;
  active: boolean;
  onAnswer(answers: CodingQuestionAnswer[]): Promise<void>;
}) {
  const { t, i18n } = useConversationMessages();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | MessageReference>("");
  const waiting = useRef(false);
  const composing = useRef(false);
  const compositionEnded = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const question = asked.questions[0];
  const text = approvalText(question, t, i18n.language);
  const labels = approvalLabels(asked);
  useEffect(() => {
    if (active) root.current?.focus();
  }, [active, asked.questionId]);
  if (!question) return null;
  const answer = async (label: string) => {
    if (waiting.current) return;
    waiting.current = true;
    setSending(true);
    setError("");
    try {
      await onAnswer([{ id: question.id, selected: [label] }]);
    } catch (reason) {
      setError(errorMessage(reason));
      waiting.current = false;
      setSending(false);
    }
  };
  return (
    <div
      ref={root}
      className="coding-decision approval"
      role="region"
      aria-label={t("approvalRequest")}
      aria-busy={sending}
      tabIndex={-1}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
        compositionEnded.current = true;
      }}
      onKeyUpCapture={() => {
        compositionEnded.current = false;
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          composing.current ||
          compositionEnded.current ||
          event.repeat
        )
          return;
        if (
          (event.target as Element).closest(
            "input, textarea, select, [contenteditable]",
          )
        )
          return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
          return;
        // A focused button already acts on Enter by itself.
        if (
          event.key === "Enter" &&
          (event.target as Element).closest("button")
        )
          return;
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        void answer(event.key === "Enter" ? labels.allow : labels.reject);
      }}
    >
      <div className="coding-decision-strip">
        <span className="coding-decision-dot" aria-hidden="true" />
        {t("pendingApproval")}
      </div>
      <div className="coding-decision-body">
        <div className="coding-decision-headline">{text.headline}</div>
        {text.detail ? (
          <div className="coding-decision-detail">{text.detail}</div>
        ) : null}
      </div>
      <div className="coding-decision-actions">
        <button
          type="button"
          className="reject"
          disabled={sending}
          onClick={() => void answer(labels.reject)}
        >
          {labels.reject === "拒绝" ? t("reject") : labels.reject}
        </button>
        <button
          type="button"
          className="allow"
          disabled={sending}
          onClick={() => void answer(labels.allow)}
        >
          {labels.allow === "允许这一次" ? t("allowOnce") : labels.allow}
        </button>
      </div>
      {error ? (
        <p className="coding-decision-error" role="alert">
          {messageText(error, i18n)}
        </p>
      ) : null}
    </div>
  );
}

/** The answer recorded for one question of a batch. */
function answerText(asked: AskedQuestion, id: string) {
  const answer = asked.answered?.find((item) => item.id === id);
  if (!answer) return conversationText("unanswered");
  return (
    new Intl.ListFormat(language.getSnapshot().locale).format([
      ...answer.selected,
      ...(answer.custom ? [answer.custom] : []),
    ]) || conversationText("skipped")
  );
}

/** Whether the batch is a tool authorization rather than a question. */
function isApproval(asked: AskedQuestion) {
  return asked.questions.some((item) => item.kind === "approval");
}

/**
 * The question form. The card above the composer shows it with the shared
 * decision chrome; the inline fallback of a second pending batch shows it with
 * its own surface.
 */
function QuestionCard({
  asked,
  onAnswer,
  bare = false,
}: {
  asked: AskedQuestion;
  onAnswer(answers: CodingQuestionAnswer[]): Promise<void>;
  /** Inside the composer card, which already draws the surface and strip. */
  bare?: boolean;
}) {
  const { t, i18n } = useConversationMessages();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | MessageReference>("");
  const waiting = useRef(false);
  const plan = asked.questions.some((item) => item.intent);
  const toggle = (id: string, label: string, multi: boolean) =>
    setSelected((current) => {
      const now = current[id] ?? [];
      return {
        ...current,
        [id]: multi
          ? now.includes(label)
            ? now.filter((item) => item !== label)
            : [...now, label]
          : [label],
      };
    });
  const submit = async () => {
    if (waiting.current) return;
    waiting.current = true;
    setSending(true);
    setError("");
    try {
      await onAnswer(
        asked.questions.map((question) => ({
          id: question.id,
          selected: selected[question.id] ?? [],
          ...(custom[question.id]?.trim()
            ? { custom: custom[question.id]!.trim() }
            : {}),
        })),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      waiting.current = false;
      setSending(false);
    }
  };
  return (
    <section
      className={`coding-question${bare ? " bare" : ""}`}
      aria-label={t("modelQuestion")}
    >
      <h3>
        <MessageCircleQuestion size={14} />
        {plan ? t("reviewPlan") : t("decisionNeeded")}
      </h3>
      {asked.questions.map((question) => (
        <fieldset key={question.id} disabled={sending}>
          <legend>
            {question.header ? <span>{question.header}</span> : null}
            {question.question}
          </legend>
          {question.detail ? (
            <div
              className={`coding-question-detail${question.intent ? " plan" : ""}`}
            >
              <WorkflowRichText text={question.detail} />
            </div>
          ) : null}
          {question.options?.map((option) => (
            <label key={option.label} className="coding-question-option">
              <input
                type={question.multiSelect ? "checkbox" : "radio"}
                name={`${asked.questionId}-${question.id}`}
                checked={(selected[question.id] ?? []).includes(option.label)}
                onChange={() =>
                  toggle(question.id, option.label, !!question.multiSelect)
                }
              />
              <span>
                {option.label}
                {question.intent?.approve === option.label ? (
                  <small>{t("implementAfterApproval")}</small>
                ) : null}
                {option.description ? (
                  <small>{option.description}</small>
                ) : null}
              </span>
            </label>
          ))}
          {/* An approval is grant-or-refuse; the backend ignores text. */}
          {question.kind === "approval" ? null : (
            <input
              className="coding-question-custom"
              aria-label={t("otherAnswer", { question: question.question })}
              placeholder={
                question.intent
                  ? t("planChangesPlaceholder")
                  : question.options?.length
                    ? t("otherAnswerPlaceholder")
                    : t("answerPlaceholder")
              }
              value={custom[question.id] ?? ""}
              onChange={(event) =>
                setCustom((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          )}
        </fieldset>
      ))}
      <div className="coding-question-actions">
        <button disabled={sending} onClick={() => void submit()}>
          {sending ? <LoaderCircle size={13} className="coding-spin" /> : null}
          {t("sendAnswer")}
        </button>
      </div>
      {error ? (
        <p className="coding-error" role="alert">
          {messageText(error, i18n)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The transcript trace of one question batch. As in DSH, the decision itself
 * happens in the card above the composer; here the batch stays as one line
 * that expands to the questions and the answers that were recorded.
 */
function QuestionNote({
  asked,
  live,
}: {
  asked: AskedQuestion;
  live: boolean;
}) {
  const { t, i18n } = useConversationMessages();
  const settled = asked.answered !== undefined;
  const summary = new Intl.ListFormat(i18n.resolvedLanguage).format(
    asked.questions.map((question) => question.question),
  );
  return (
    <details className="coding-question-note">
      <summary title={summary}>
        <MessageCircleQuestion size={14} aria-hidden="true" />
        <span className="coding-question-note-state">
          {settled
            ? t("answered")
            : live
              ? t("waitingAnswer")
              : t("questionEnded")}
        </span>
        <span className="coding-question-note-question">{summary}</span>
        <ChevronDown
          size={12}
          className="coding-question-note-chevron"
          aria-hidden="true"
        />
      </summary>
      <dl className="coding-question-note-body">
        {asked.questions.map((question) => (
          <div key={question.id}>
            <dt>
              {question.header
                ? t("questionWithHeader", {
                    header: question.header,
                    question: question.question,
                  })
                : question.question}
            </dt>
            <dd>{answerText(asked, question.id)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * A pending question above the composer, after DSH: it takes over the input
 * position, so the draft stays and sending waits until it is answered.
 */
function QuestionDock({
  asked,
  active,
  stopControl,
  onAnswer,
}: {
  asked: AskedQuestion;
  /** False while the pane is hidden; then the card must not take focus. */
  active: boolean;
  stopControl: React.ReactNode;
  onAnswer(answers: CodingQuestionAnswer[]): Promise<void>;
}) {
  const { t } = useConversationMessages();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) root.current?.focus();
  }, [active, asked.questionId]);
  return (
    <div
      ref={root}
      className="coding-decision question"
      role="region"
      aria-label={t("waitingAnswer")}
      tabIndex={-1}
    >
      <div className="coding-decision-strip">
        <span className="coding-decision-dot" aria-hidden="true" />
        {t("waitingAnswer")}
        {stopControl}
      </div>
      <div className="coding-decision-body">
        <QuestionCard asked={asked} onAnswer={onAnswer} bare />
      </div>
    </div>
  );
}

/**
 * One declared file: copy its full path anywhere, and on desktop reveal it in
 * the file manager. Revealing never opens the file, so a script the agent
 * produced cannot be run from here.
 */
function DeliverableItem({
  path,
  directory,
}: {
  path: string;
  directory: string;
}) {
  const { t, i18n } = useConversationMessages();
  const [note, setNote] = useState<string | MessageReference>("");
  const reveal = globalThis.window?.auraHost?.files?.reveal;
  const full = fullPath(path, directory);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), 2000);
    return () => clearTimeout(timer);
  }, [note]);
  const run = async (
    action: () => Promise<void>,
    done: string | MessageReference,
  ) => {
    try {
      await action();
      setNote(done);
    } catch (reason) {
      setNote(errorMessage(reason));
    }
  };
  return (
    <li data-row-highlight>
      <FileText size={13} />
      <code title={full}>{path}</code>
      <span className="coding-report-actions">
        <button
          className="icon-control row-control"
          aria-label={t("copyPathLabel", { path })}
          title={t("copyPath")}
          onClick={() =>
            void run(() => writeClipboard(full), message("copied"))
          }
        >
          <Copy size={13} />
        </button>
        {reveal ? (
          <button
            className="icon-control row-control"
            aria-label={t("revealLabel", { path })}
            title={t("reveal")}
            onClick={() =>
              void run(
                () => nativeCall(() => reveal(directory, path)),
                message("located"),
              )
            }
          >
            <FolderSearch size={13} />
          </button>
        ) : null}
      </span>
      {note ? (
        <span className="coding-report-note" role="status">
          {messageText(note, i18n)}
        </span>
      ) : null}
    </li>
  );
}

function PromptImages({
  endpoint,
  images,
}: {
  endpoint: string;
  images?: ChatImage[];
}) {
  const { t } = useConversationMessages();
  if (!images?.length) return null;
  return (
    <ImageThumbnails
      className="message-images coding-prompt-images"
      images={images.map((image) => ({
        key: image.assetId,
        src: chatImageUrl(endpoint, image.assetId),
        name: image.name ?? t("attachedImage"),
      }))}
    />
  );
}

const TurnView = memo(function TurnView({
  turn,
  latest,
  highlighted = false,
  visible,
  directory,
  endpoint,
  dockedQuestionId,
  onAnswer,
  onApplyFlow,
  onRepeatFlow,
  hideFlowSvg = false,
  onForkTurn,
}: {
  turn: Turn;
  latest: boolean;
  /** Briefly marks the turn a search result jumped to. */
  highlighted?: boolean;
  visible: boolean;
  /** Runtime endpoint; sent images are served from it. */
  endpoint: string;
  /** Project directory; deliverable paths resolve against it. */
  directory: string;
  /** The batch answered in the card above the composer, if any. */
  dockedQuestionId?: string;
  onAnswer?(
    turnId: string,
    questionId: string,
    answers: CodingQuestionAnswer[],
  ): Promise<void>;
  onApplyFlow?(code: string): void;
  onRepeatFlow?(run: FlowRun): void;
  hideFlowSvg?: boolean;
  onForkTurn?(endSeq: number): void;
}) {
  const { t, i18n } = useConversationMessages();
  const running = turn.status === "running";
  const endSeq = turn.endSeq;
  const waiting = turn.questions.some((item) => !item.answered);
  const [open, setOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [processFocused, setProcessFocused] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const { finalReplyIndex, canCollapse } = turnPresentation(turn);
  const processVisible = !canCollapse || processOpen || processFocused;
  const groups = turn.timeline.filter((item) => item.kind === "tools");
  const allExpanded =
    (!turn.progress?.total || open) &&
    groups.every((group) => expandedGroups[group.callIds[0]!] ?? open);
  const tools = new Map(turn.tools.map((tool) => [tool.callId, tool]));
  const questions = new Map(
    turn.questions.map((asked) => [asked.questionId, asked]),
  );
  const workflows = new Map(turn.workflows?.map((run) => [run.runId, run]));
  const hasSteps = turn.tools.length > 0 || !!turn.progress?.total;
  const foldedTools = processVisible
    ? undefined
    : summarizeToolGroup(turn.tools);
  const expandable = canCollapse || hasSteps;
  const expanded = canCollapse ? processVisible : allExpanded;
  const missingFinalReply = turn.status === "complete" && finalReplyIndex < 0;
  const stateLabel = running
    ? turn.waitingForService
      ? t("connectingService")
      : waiting
        ? t("waitingAnswer")
        : t("executing")
    : turn.status === "complete"
      ? t("executionComplete")
      : turn.status === "stopped"
        ? t("stopped")
        : t("executionFailed");
  const StateIcon = running
    ? waiting
      ? MessageCircleQuestion
      : LoaderCircle
    : turn.status === "complete"
      ? CircleCheck
      : turn.status === "stopped"
        ? CircleStop
        : CircleX;
  return (
    <article
      className="coding-turn"
      data-turn-id={turn.id}
      data-search-focus={highlighted ? "" : undefined}
      data-actions-reveal={latest ? "always" : "hover"}
      onFocusCapture={(event) => {
        setProcessFocused(
          event.target.closest("[data-coding-process-record]") !== null,
        );
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setProcessFocused(false);
      }}
    >
      {turn.prompt ? (
        <div className="coding-prompt">
          <MaskedUserText text={turn.prompt} />
        </div>
      ) : null}
      <PromptImages endpoint={endpoint} images={turn.images} />
      {canCollapse ||
      hasSteps ||
      turn.status !== "complete" ||
      missingFinalReply ? (
        <div className="coding-work">
          <span className="sr-only" role="status">
            {stateLabel}
          </span>
          <button
            type="button"
            className={`coding-process ${turn.status}`}
            aria-expanded={expandable ? expanded : undefined}
            disabled={!expandable}
            data-open={(expandable && expanded) || undefined}
            title={
              expandable
                ? t(
                    canCollapse
                      ? expanded
                        ? "collapseExecution"
                        : "expandExecution"
                      : expanded
                        ? "collapseTools"
                        : "expandTools",
                  )
                : undefined
            }
            onClick={(event) => {
              if (canCollapse) {
                event.currentTarget.focus();
                setProcessOpen(!processVisible);
              } else {
                setOpen(!allExpanded);
                setExpandedGroups({});
              }
            }}
          >
            <StateIcon
              size={15}
              className={`coding-process-icon${running && !waiting ? " coding-spin" : ""}`}
              aria-hidden="true"
            />
            <span className="coding-process-label">
              <span className="coding-process-state">{stateLabel}</span>
              {running || turn.endedAt !== undefined ? (
                <span className="coding-process-number">
                  {" · "}
                  <TurnDuration turn={turn} visible={visible} />
                </span>
              ) : null}
              {turn.tools.length
                ? ` · ${t("toolCalls", { count: turn.tools.length })}`
                : null}
              {foldedTools?.failed ? (
                <span className="coding-tool-group-failed">
                  {` · ${t("failedCount", { count: foldedTools.failed })}`}
                </span>
              ) : null}
              {foldedTools?.stopped ? (
                <span className="coding-tool-group-stopped">
                  {` · ${t("interruptedCount", { count: foldedTools.stopped })}`}
                </span>
              ) : null}
            </span>
            {expandable ? (
              <ChevronDown
                size={14}
                className="coding-process-chevron"
                aria-hidden="true"
              />
            ) : null}
          </button>
          {processVisible &&
          (canCollapse || open) &&
          turn.progress &&
          turn.progress.total > 0 ? (
            <div className="coding-process-body">
              <div className="coding-progress">
                <ListTodo size={14} aria-hidden="true" />
                <div
                  className="coding-progress-bar"
                  role="progressbar"
                  aria-label={t("taskProgress")}
                  aria-valuemin={0}
                  aria-valuemax={turn.progress.total}
                  aria-valuenow={turn.progress.done}
                >
                  <span
                    style={{
                      width: `${(turn.progress.done / turn.progress.total) * 100}%`,
                    }}
                  />
                </div>
                <span>
                  {t("tasksProgress", {
                    done: turn.progress.done,
                    total: turn.progress.total,
                  })}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {!running && processVisible ? (
        <ChangedFilesView turn={turn} directory={directory} />
      ) : null}
      {turn.timeline.map((item, index) => {
        const isProcess =
          item.kind === "tools" ||
          (item.kind === "text" && index !== finalReplyIndex);
        if (isProcess && !processVisible) return null;
        if (item.kind === "notice")
          return (
            <p key={index} className="coding-notice" role="status">
              {messageText(item.text, i18n)}
            </p>
          );
        if (item.kind === "web")
          return (
            <aside key={index} className="coding-web-sources">
              <span>
                {t("webSources")}
                {item.event.statusCode
                  ? ` · HTTP ${item.event.statusCode}`
                  : ""}
                {item.event.truncated ? ` · ${t("truncated")}` : ""}
              </span>
              {item.event.sources.map((source, at) => (
                <a key={at} href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>
              ))}
            </aside>
          );
        if (item.kind === "text")
          return item.text.trim() ? (
            <div
              key={index}
              className="coding-reply"
              data-coding-process-record={isProcess || running || undefined}
            >
              <WorkflowRichText
                text={
                  hideFlowSvg
                    ? item.text.replace(
                        /```svg[^\n]*\n[\s\S]*?(?:```|$)/g,
                        `
${t("svgOnCanvas")}
`,
                      )
                    : item.text
                }
              />
            </div>
          ) : null;
        if (item.kind === "tools") {
          const key = item.callIds[0]!;
          const expanded = expandedGroups[key] ?? open;
          return (
            <ToolGroup
              key={`tools:${key}`}
              tools={item.callIds.flatMap((id) => {
                const tool = tools.get(id);
                return tool ? [tool] : [];
              })}
              expanded={expanded}
              onToggle={() =>
                setExpandedGroups((current) => ({
                  ...current,
                  [key]: !expanded,
                }))
              }
            />
          );
        }
        if (item.kind === "question") {
          const asked = questions.get(item.questionId);
          if (!asked) return null;
          // The pending batch is answered in the card above the composer, so
          // its transcript entry stays empty until the decision is recorded.
          if (running && item.questionId === dockedQuestionId) return null;
          if (isApproval(asked))
            return (
              <ApprovalNote
                key={item.questionId}
                asked={asked}
                live={running}
              />
            );
          // A second open batch keeps its own inline form: only one card can
          // own the composer, and an unanswerable question would be a dead end.
          if (running && asked.answered === undefined && onAnswer)
            return (
              <QuestionCard
                key={item.questionId}
                asked={asked}
                onAnswer={(answers) =>
                  onAnswer(turn.id, asked.questionId, answers)
                }
              />
            );
          return (
            <QuestionNote key={item.questionId} asked={asked} live={running} />
          );
        }
        if (item.kind === "workflow") {
          const run = workflows.get(item.runId);
          return run ? (
            <NestedFlowRun
              key={item.runId}
              endpoint={endpoint}
              runId={run.runId}
              onRepeat={onRepeatFlow}
            />
          ) : null;
        }
        return (
          <div
            key={item.requestId ?? index}
            className="coding-prompt coding-steer"
          >
            {item.text ? <MaskedUserText text={item.text} /> : null}
            <PromptImages endpoint={endpoint} images={item.images} />
            {item.delivery ? (
              <div className="coding-steer-status" role="status">
                {item.delivery === "unconfirmed"
                  ? t("deliveryUnknown")
                  : item.delivery === "canceled"
                    ? t("deliveryCancelled")
                    : item.delivery === "queued"
                      ? running
                        ? t("waitingAgentRead")
                        : t("retainedForRead")
                      : t("checkingDelivery")}
              </div>
            ) : null}
          </div>
        );
      })}
      {onApplyFlow &&
      turn.status === "complete" &&
      extractFlowCode(turn.reply) ? (
        <button
          className="tool-button"
          onClick={() => onApplyFlow(extractFlowCode(turn.reply)!)}
        >
          {t("applyWorkflow")}
        </button>
      ) : null}
      {turn.error ? (
        <p className="coding-error" role="alert">
          {messageText(turn.error, i18n)}
        </p>
      ) : null}
      {turn.deliverables.length ? (
        <section className="coding-report" aria-label={t("deliverables")}>
          <h3>{t("deliverables")}</h3>
          <ul>
            {turn.deliverables.map((path) => (
              <DeliverableItem key={path} path={path} directory={directory} />
            ))}
          </ul>
        </section>
      ) : null}
      {turn.status === "complete" ? (
        <TurnActions
          reply={turn.reply}
          endedAt={turn.endedAt}
          usage={turn.usage}
          onFork={
            onForkTurn && endSeq !== undefined
              ? () => onForkTurn(endSeq)
              : undefined
          }
        />
      ) : null}
    </article>
  );
});

/**
 * The recorded file changes have their own list inside the execution details.
 */
const COLLAPSED_FILES = 4;

/** Icon and tint per file kind, so a list of changes is scannable at a glance. */
const kindIcons: Record<FileKind, LucideIcon> = {
  code: FileCode,
  style: Palette,
  markup: FileCodeCorner,
  config: FileBraces,
  markdown: FileType,
  image: FileImage,
  video: FileVideoCamera,
  audio: FileMusic,
  archive: FileArchive,
  data: FileSpreadsheet,
  shell: FileTerminal,
  lock: FileLock,
  text: FileText,
  unknown: FileIcon,
};

/** Copies a path or reveals it, with a short note in place of the buttons. */
function useFileActions(directory: string) {
  const { i18n } = useConversationMessages();
  const [note, setNote] = useState<string | MessageReference>("");
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), 2000);
    return () => clearTimeout(timer);
  }, [note]);
  const reveal = globalThis.window?.auraHost?.files?.reveal;
  const run = async (
    action: () => Promise<void>,
    done: string | MessageReference,
  ) => {
    try {
      await action();
      setNote(done);
    } catch (reason) {
      setNote(errorMessage(reason));
    }
  };
  return {
    note: messageText(note, i18n),
    copy: (path: string) =>
      void run(
        () => writeClipboard(fullPath(path, directory)),
        message("pathCopied"),
      ),
    ...(reveal
      ? {
          reveal: (path: string) =>
            void run(
              () => nativeCall(() => reveal(directory, path)),
              message("revealed"),
            ),
        }
      : {}),
  };
}

/**
 * One changed file: a kind icon, the file name with its folder dimmed after
 * it, line counts, and actions that fit the kind. Text files can unfold their
 * diff in place; binary ones only offer the path and the folder.
 */
function RecapFile({
  path,
  added,
  removed,
  diffs,
  directory,
}: {
  path: string;
  added: number;
  removed: number;
  diffs: CodingFileDiff[];
  directory: string;
}) {
  const { t } = useConversationMessages();
  const [open, setOpen] = useState(false);
  const actions = useFileActions(directory);
  const shown = displayPath(path, directory);
  const kind = fileKind(path);
  const Icon = kindIcons[kind];
  const binary = BINARY_KINDS.has(kind);
  const created =
    diffs.length > 0 && diffs.every((diff) => diff.oldText === null);
  const dir = fileDir(shown);
  return (
    <li
      className="coding-recap-file"
      data-kind={kind}
      data-open={open || undefined}
    >
      <div className="coding-recap-file-row" data-row-highlight>
        <span className="coding-recap-file-icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="coding-recap-file-name" title={shown}>
          <span>{fileName(shown)}</span>
          {dir ? <small>{dir}</small> : null}
        </span>
        {created ? (
          <span className="coding-recap-badge">{t("newFile")}</span>
        ) : null}
        <span className="coding-recap-counts">
          {binary ? (
            <span>{t("binary")}</span>
          ) : (
            <>
              <span className="coding-diff-added">+{formatNumber(added)}</span>
              <span className="coding-diff-removed">
                -{formatNumber(removed)}
              </span>
            </>
          )}
        </span>
        <span className="coding-recap-actions">
          {actions.note ? (
            <span className="coding-recap-note" role="status">
              {actions.note}
            </span>
          ) : (
            <>
              {!binary && diffs.length ? (
                <button
                  type="button"
                  className="icon-control row-control"
                  aria-label={t(
                    open ? "collapseChangesLabel" : "viewChangesLabel",
                    { path: fileName(shown) },
                  )}
                  aria-expanded={open}
                  title={open ? t("collapseChanges") : t("viewChanges")}
                  onClick={() => setOpen((value) => !value)}
                >
                  <FileDiff size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-control row-control"
                aria-label={t("copyPathLabel", { path: fileName(shown) })}
                title={t("copyPath")}
                onClick={() => actions.copy(path)}
              >
                <Copy size={14} />
              </button>
              {actions.reveal ? (
                <button
                  type="button"
                  className="icon-control row-control"
                  aria-label={t("revealLabel", { path: fileName(shown) })}
                  title={t("reveal")}
                  onClick={() => actions.reveal?.(path)}
                >
                  <FolderSearch size={14} />
                </button>
              ) : null}
            </>
          )}
        </span>
      </div>
      {open ? (
        <div className="coding-diffs coding-recap-diff">
          {diffs.map((diff, index) => (
            <DiffCard key={index} diff={diff} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function ChangedFilesView({
  turn,
  directory,
}: {
  turn: Turn;
  directory: string;
}) {
  const { t } = useConversationMessages();
  const [expanded, setExpanded] = useState(false);
  const { files } = useMemo(() => summarizeTurn(turn, fileDiff), [turn]);
  if (!files.length) return null;
  const foldable = files.length > COLLAPSED_FILES;
  const shown = foldable && !expanded ? files.slice(0, COLLAPSED_FILES) : files;
  const diffsByPath = new Map<string, CodingFileDiff[]>();
  for (const tool of turn.tools)
    for (const diff of tool.diffs ?? []) {
      const list = diffsByPath.get(diff.path) ?? [];
      list.push(diff);
      diffsByPath.set(diff.path, list);
    }
  return (
    <section
      className="coding-recap"
      aria-label={t("fileChanges")}
      data-coding-process-record
    >
      <h3 className="coding-recap-title">{t("fileChanges")}</h3>
      <ul className="coding-recap-files">
        {shown.map((file) => (
          <RecapFile
            key={file.path}
            path={file.path}
            added={file.added}
            removed={file.removed}
            diffs={diffsByPath.get(file.path) ?? []}
            directory={directory}
          />
        ))}
      </ul>
      {foldable ? (
        <button
          type="button"
          className="coding-recap-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("collapse") : t("allFiles", { count: files.length })}
          <ChevronDown
            size={14}
            aria-hidden="true"
            {...(expanded ? { className: "coding-recap-toggle-up" } : {})}
          />
        </button>
      ) : null}
    </section>
  );
}

/** Stable empty list so an idle transcript does not re-run its effects. */
const noTurns: Turn[] = [];

/**
 * The turn containing a DSH log position: the last turn whose `turn/start`
 * seq (encoded in its id as `turn-<seq>`) is at or before it.
 */
export function focusTurnIndex(
  turns: readonly Turn[],
  seq: number,
): number | undefined {
  let found: number | undefined;
  turns.forEach((turn, index) => {
    const start = /:turn-(\d+)$/u.exec(turn.id)?.[1];
    if (start !== undefined && Number(start) <= seq) found = index;
  });
  return found;
}

const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Re-renders once a second while `active`, for live elapsed time. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function TurnDuration({ turn, visible }: { turn: Turn; visible: boolean }) {
  const { i18n } = useConversationMessages();
  const now = useTicker(turn.status === "running" && visible);
  return duration(
    (turn.endedAt ?? now) - turn.startedAt,
    i18n.resolvedLanguage ?? "en",
  );
}

/** Sends one request; resolves with the finished turn, or nothing if refused. */
export type ConversationSend = (
  text?: string,
  attached?: ChatImage[],
  options?: { preserveDraft?: boolean; intent?: CodingRunIntent },
) => Promise<Turn | undefined>;

/** Each level has its own shield glyph, matching DSH's permission set. */
const PERMISSION_OPTIONS = {
  "read-only": {
    label: "readOnly",
    detail: "readOnlyDetail",
    Icon: ShieldCheck,
  },
  "workspace-write": {
    label: "workspaceWrite",
    detail: "workspaceWriteDetail",
    Icon: ShieldHalf,
  },
  "danger-full-access": {
    label: "fullAccess",
    detail: "fullAccessDetail",
    Icon: ShieldAlert,
  },
} satisfies Record<
  CodingPermission,
  {
    label: ConversationMessageKey;
    detail: ConversationMessageKey;
    Icon: typeof ShieldCheck;
  }
>;

/**
 * One conversation's transcript and composer. The studio hosts the main
 * conversation and its retained side chat; both go through the
 * same streaming, answer and history path.
 */
export function ConversationPane({
  endpoint,
  visible = true,
  preparing = false,
  provider,
  projectId,
  directory = "",
  label,
  sessionId,
  forkFrom,
  branchFrom,
  branchAt,
  focus,
  onForkTurn,
  history,
  historyTime = 0,
  context,
  initialDraft,
  onDraftChange,
  onAttachmentsChange,
  draftInsert,
  onApplyFlow,
  onFlowReply,
  flows,
  flowsLoading = false,
  flowRequest,
  onFlowRequestTaken,
  composerExtra,
  composerLeading,
  readOnly = false,
  placeholder,
  empty,
  footnote,
  onOpen,
  onSettled,
  onProvider,
  modelConfig,
  onModelConfig,
  permission,
  draftPermission,
  permissionSaving = false,
  onPermission,
  initialSend,
  onInitialSendTaken,
  sendRef,
  onRunning,
  onTurns,
}: {
  endpoint: string;
  visible?: boolean;
  /** A restored workspace can accept a request while its service starts. */
  preparing?: boolean;
  provider: Workspace["provider"];
  /** Missing while workspaces load; history and draft remain available. */
  projectId?: string;
  directory?: string;
  /** Accessible name of the composer. */
  label: string;
  /** Selected conversation; undefined starts a new one on the first send. */
  sessionId?: string;
  /** The parent whose context seeds the side chat's first turn only. */
  forkFrom?: string;
  branchFrom?: string;
  branchAt?: number;
  /** A log position to scroll to once, e.g. a search match. */
  focus?: { conversationId: string; seq: number; key: number };
  onForkTurn?(endSeq: number): void;
  history?: ChatMessage[];
  historyTime?: number;
  context?: string;
  initialDraft?: string;
  onDraftChange?(draft: string): void;
  onAttachmentsChange?(attached: boolean): void;
  draftInsert?: { id: string; text: string };
  onApplyFlow?(code: string): void;
  /** Completed replies can supply the current Flow editor's SVG artifact. */
  onFlowReply?(reply: string): void;
  flows?: FlowCatalogEntry[];
  flowsLoading?: boolean;
  flowRequest?: FlowConversationRequest;
  onFlowRequestTaken?(): void;
  composerExtra?: React.ReactNode;
  /** Workspace context inside the card, beside the attachment menu. */
  composerLeading?: React.ReactNode;
  /** Archived parents retain a readable transcript, but cannot accept turns. */
  readOnly?: boolean;
  placeholder: string;
  /** Hint above an empty conversation; omit to show only the composer. */
  empty?: React.ReactNode;
  footnote?: React.ReactNode;
  /** A new conversation got its id. */
  onOpen?(sessionId: string, selection?: ChatModelSelection): void;
  /** A turn started or ended, so listings may have changed. */
  onSettled?(): void;
  onProvider(provider: Workspace["provider"]): void;
  modelConfig: ChatModelSelection;
  onModelConfig(selection: ChatModelSelection): void;
  permission?: CodingPermission;
  /** A choice made before the conversation has been saved. */
  draftPermission?: CodingPermission;
  permissionSaving?: boolean;
  onPermission?(permission: CodingPermission): Promise<void>;
  /** Sent once when it changes, for example a hand-off from another page. */
  initialSend?: { prompt: string; images?: ChatImage[] };
  onInitialSendTaken?(): void;
  /** Lets the host send into this conversation. */
  sendRef?: React.RefObject<ConversationSend | undefined>;
  onRunning?(running: boolean): void;
  onTurns?(turns: readonly Turn[]): void;
}) {
  const { t, i18n } = useConversationMessages();
  const [turns, setTurns] = useState<Record<string, Turn[]>>({});
  const remote = useConversation(
    endpoint,
    provider === "offline" ? undefined : sessionId,
  );
  // A normal send confirms within moments; only a slow confirmation is shown.
  const pendingCommand = remote.pending?.commandId;
  const [slowPending, setSlowPending] = useState<string>();
  useEffect(() => {
    if (!pendingCommand) return;
    const timer = setTimeout(() => setSlowPending(pendingCommand), 1_500);
    return () => clearTimeout(timer);
  }, [pendingCommand]);
  const draftKey =
    sessionId ??
    (branchFrom ? `fork:${branchFrom}:${branchAt ?? "latest"}` : "draft");
  const { draft, setDraft, moveDraft } = useConversationDraft(
    draftKey,
    initialDraft,
  );
  const { flags } = useIntegrations();
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [error, setError] = useState<string | MessageReference>("");
  const [collaborations, setCollaborations] = useState<
    Partial<Record<string, CodingCollaboration>>
  >({});
  const [draftIntents, setDraftIntents] = useState<
    Partial<Record<string, "execute">>
  >({});
  const [collaborationSaving, setCollaborationSaving] = useState(false);
  const collaboration = sessionId ? collaborations[sessionId] : undefined;
  const goal = collaboration?.goal;
  const draftIntent = draftIntents[draftKey];
  const [historyRequest, setHistoryRequest] = useState<{
    id: string;
    state: "loading" | "error";
    message?: string | MessageReference;
  }>();
  const [historyRetry, setHistoryRetry] = useState(0);
  const awaitingService = useRef(new Set<string>());
  const [dragging, setDragging] = useState(false);
  const images = useImageAttachments(endpoint, draftKey);
  /** Composer attachment currently opened in the full-size viewer. */
  const [previewKey, setPreviewKey] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  /** Conversations already read from the log; a live turn is never overwritten. */
  const loaded = useRef(new Set<string>());
  const historyBlocked = !!sessionId && !loaded.current.has(sessionId);
  const historyError =
    historyBlocked &&
    historyRequest?.id === sessionId &&
    historyRequest.state === "error"
      ? historyRequest.message
      : undefined;
  const loadingHistory = historyBlocked && !historyError;
  const [historyPages, setHistoryPages] = useState<
    Record<
      string,
      { hasMore: boolean; beforeSeq?: number; throughSeq?: number }
    >
  >({});
  const [olderLoading, setOlderLoading] = useState(false);
  const olderRequest = useRef<AbortController | undefined>(undefined);
  const [historyWindow, setHistoryWindow] = useState<{
    id: string;
    end: number;
  }>();
  const nearBottom = useRef(true);
  /**
   * One stream per conversation. The pane is reused when switching
   * conversations, so a single controller would let "stop" in one
   * conversation abort another one's turn.
   */
  const streams = useRef(new Map<string, ConversationStream>());
  const sending = useRef(new Map<string, AbortController>());
  const [stopping, setStopping] = useState(false);
  const guidanceRequests = useRef(new Map<string, AbortController>());
  const [guidance, setGuidance] = useState<
    Record<string, GuidanceState | undefined>
  >({});
  const guidanceState = sessionId ? guidance[sessionId] : undefined;
  const steering =
    guidanceState?.phase === "sending" || guidanceState?.phase === "checking";
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const imported = useMemo(
    () =>
      history && sessionId
        ? turnsFromHistory(
            `import:${sessionId}`,
            legacyConversationTurns(history, historyTime),
          )
        : noTurns,
    [history, historyTime, sessionId],
  );
  const shown = sessionId ? (turns[sessionId] ?? imported) : noTurns;
  const reportedFlowReply = useRef("");
  useEffect(() => {
    const turn = shown.at(-1);
    if (!visible || !onFlowReply || turn?.status !== "complete") return;
    const key = `${sessionId}:${turn.id}:${turn.reply}`;
    if (reportedFlowReply.current === key) return;
    reportedFlowReply.current = key;
    onFlowReply(turn.reply);
  }, [shown, sessionId, visible, onFlowReply]);
  // Only the oldest open batch in this conversation owns the dock.
  const pending = useMemo(
    () => (readOnly ? undefined : pendingQuestion(shown)),
    [readOnly, shown],
  );
  const questionDocked = pending !== undefined && !isApproval(pending.asked);
  const windowEnd =
    historyWindow && historyWindow.id === sessionId
      ? Math.min(historyWindow.end, shown.length)
      : shown.length;
  const windowStart = Math.max(0, windowEnd - 40);
  const visibleTurns = shown.slice(windowStart, windowEnd);
  const running =
    isExecutionActive(remote.snapshot?.execution) ||
    shown.some((turn) => turn.status === "running");
  const offline = provider === "offline";
  const mode = providerMode(provider);
  const flowFormId = useId();
  const [flowForms, setFlowForms] = useState<
    Record<string, { flow: FlowCatalogEntry; text: string; mode: FlowMode }>
  >({});
  const flowForm = flowForms[draftKey];
  const openFlow = useCallback(
    (flow: FlowCatalogEntry, run?: FlowRun) => {
      setFlowForms((current) => ({
        ...current,
        [draftKey]: {
          flow,
          text: JSON.stringify(
            run ? run.input : schemaInitialValue(flow.inputSchema),
            null,
            2,
          ),
          mode: run?.mode ?? mode,
        },
      }));
    },
    [draftKey, mode],
  );
  const repeatFlow = useCallback(
    (run: FlowRun) => {
      const flow = flows?.find((entry) => entry.id === run.flow.id) ?? {
        id: run.flow.id,
        title: run.flow.title,
        description: "",
        available: false,
      };
      openFlow(flow, run);
    },
    [flows, openFlow],
  );
  const takenFlowRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible || !flowRequest || takenFlowRequest.current === flowRequest.id)
      return;
    takenFlowRequest.current = flowRequest.id;
    openFlow(flowRequest.flow);
    onFlowRequestTaken?.();
  }, [flowRequest, visible, openFlow, onFlowRequestTaken]);
  const closeFlow = () => {
    setFlowForms((current) => {
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
    editor.current?.focus();
  };
  const [compactStates, setCompactStates] = useState<
    Record<string, { busy: boolean; text: string | MessageReference }>
  >({});
  const compacting = compactStates[sessionId ?? ""]?.busy ?? false;
  const compactNotice = compactStates[sessionId ?? ""]?.text ?? "";
  async function compact() {
    const id = sessionId ?? "";
    const update = (busy: boolean, text: string | MessageReference) =>
      setCompactStates((current) => ({ ...current, [id]: { busy, text } }));
    if (!id) {
      update(false, message("compactNeedsMessage"));
      return;
    }
    if (compacting || running) return;
    update(true, message("compacting"));
    try {
      const result = await compactCoding(endpoint, id);
      update(
        false,
        result.compacted
          ? message("compacted", {
              messages: result.replacedMessages,
              tokens: result.savedTokens ?? 0,
            })
          : message("nothingToCompact"),
      );
    } catch (cause) {
      update(false, errorMessage(cause, message("compactFailed")));
    }
  }
  const chooseCollaboration = async (
    action: Exclude<CodingCollaborationAction, "plan">,
  ) => {
    if (
      offline ||
      readOnly ||
      running ||
      goal?.armed ||
      historyBlocked ||
      collaborationSaving
    )
      return false;
    setError("");
    if (!sessionId || (!shown.length && !collaboration?.planning && !goal)) {
      if (action === "execute")
        setDraftIntents((current) => ({ ...current, [draftKey]: "execute" }));
      return true;
    }
    const id = sessionId;
    setCollaborationSaving(true);
    try {
      const state = await changeCodingCollaboration(endpoint, id, action);
      setCollaborations((current) => ({ ...current, [id]: state }));
      setDraftIntents((current) => ({ ...current, [draftKey]: undefined }));
      return true;
    } catch (reason) {
      setError(errorMessage(reason, message("collaborationFailed")));
      return false;
    } finally {
      setCollaborationSaving(false);
    }
  };
  const commands = useComposerCommands({
    endpoint,
    projectId,
    draftKey,
    draft,
    setDraft,
    flows: flows ?? [],
    running,
    enabled: !!projectId && !offline && !readOnly && !questionDocked,
    onFlow: openFlow,
    editor,
    onCommand(command) {
      if (command === "model") setModelOpenRequest((value) => value + 1);
      else if (command === "stop") void stop();
      else if (command === "compact") void compact();
      else editor.current?.focus();
    },
  });
  useEffect(() => onDraftChange?.(draft), [draft, onDraftChange]);
  useEffect(
    () => onAttachmentsChange?.(images.attachments.length > 0),
    [images.attachments.length, onAttachmentsChange],
  );
  const insertedDraft = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!draftInsert || insertedDraft.current === draftInsert.id) return;
    insertedDraft.current = draftInsert.id;
    setDraft((current) =>
      current.trim() ? `${current}\n\n${draftInsert.text}` : draftInsert.text,
    );
    editor.current?.focus();
  }, [draftInsert, setDraft]);

  useEffect(() => onRunning?.(running), [running, onRunning]);
  useEffect(() => onTurns?.(shown), [shown, onTurns]);
  useEffect(() => {
    if (!sessionId) return;
    nearBottom.current = true;
    setHistoryWindow(undefined);
    setOlderLoading(false);
    setTurns((current) => {
      if (!Object.hasOwn(current, sessionId)) return current;
      const { [sessionId]: selected, ...rest } = current;
      return { ...rest, [sessionId]: selected! };
    });
    return () => olderRequest.current?.abort();
  }, [sessionId]);
  useEffect(() => {
    const retained = retainConversations(
      turns,
      sessionId,
      streams.current.keys(),
    );
    if (retained === turns) return;
    const evicted = new Set(
      Object.keys(turns).filter((id) => !Object.hasOwn(retained, id)),
    );
    for (const id of evicted) loaded.current.delete(id);
    setTurns(retained);
    setCollaborations((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => !evicted.has(id)),
      ),
    );
    setHistoryPages((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => !evicted.has(id)),
      ),
    );
  }, [turns, sessionId]);

  useEffect(() => {
    const snapshot = remote.snapshot;
    if (!sessionId || !snapshot) return;
    loaded.current.add(sessionId);
    const restored = turnsFromHistory(sessionId, snapshot.turns);
    const execution = snapshot.execution;
    if (execution && !restored.some((turn) => turn.status === "running")) {
      const pending = newTurn(
        `${sessionId}:execution-${execution.id}`,
        execution.prompt,
        execution.startedAt,
      );
      pending.waitingForService = execution.status === "preparing";
      // Completed native turns can still have execution cleanup in progress.
      if (
        !restored.length ||
        restored.at(-1)!.startedAt < execution.startedAt
      ) {
        if (isExecutionActive(execution)) restored.push(pending);
        else if (execution.status !== "complete")
          restored.push(
            finishTurn(
              pending,
              execution.status === "error" ? "error" : "stopped",
              execution.endedAt,
              execution.error === undefined
                ? undefined
                : apiErrorText(execution.errorDetails, execution.error),
            ),
          );
      }
    }
    setTurns((current) => ({
      ...current,
      [sessionId]: mergeConversationWindow(
        current[sessionId] ?? [],
        restored,
        snapshot.hasMore,
      ),
    }));
    if (snapshot.collaboration)
      setCollaborations((current) => ({
        ...current,
        [sessionId]: snapshot.collaboration!,
      }));
    setHistoryRequest(undefined);
    setHistoryPages((current) => {
      const previous = current[sessionId];
      // A refresh of the newest window must not move an older paging cursor forward.
      if (
        snapshot.hasMore &&
        previous?.beforeSeq !== undefined &&
        snapshot.beforeSeq !== undefined &&
        previous.beforeSeq < snapshot.beforeSeq
      )
        return current;
      return {
        ...current,
        [sessionId]: {
          hasMore: snapshot.hasMore,
          beforeSeq: snapshot.beforeSeq,
          throughSeq: snapshot.throughSeq,
        },
      };
    });
  }, [endpoint, sessionId, remote.snapshot]);

  // Opening a stored conversation reads its transcript back from the log, so
  // a reload or another device shows the same steps, diffs and answers.
  // Conversations started in this pane already hold their live turns.
  useEffect(() => {
    if (!sessionId || loaded.current.has(sessionId)) return;
    const id = sessionId;
    const abort = new AbortController();
    setHistoryRequest({ id, state: "loading" });
    conversationHistory(endpoint, id, abort.signal)
      .then((history) => {
        if (abort.signal.aborted) return;
        loaded.current.add(id);
        const rememberCollaboration = (
          state: CodingCollaboration | undefined,
        ) => {
          if (abort.signal.aborted || !state) return;
          setCollaborations((current) =>
            current[id] ? current : { ...current, [id]: state },
          );
        };
        if (history.collaboration) rememberCollaboration(history.collaboration);
        else
          void readCodingCollaboration(endpoint, id, abort.signal)
            .then(rememberCollaboration)
            .catch(() => {
              // Cold history remains usable while the execution host starts.
            });
        setHistoryPages((current) => ({
          ...current,
          [id]: {
            hasMore: history.hasMore,
            beforeSeq: history.beforeSeq,
            throughSeq: history.throughSeq,
          },
        }));
        setTurns((current) =>
          // A turn sent while history was loading wins over the snapshot.
          current[id]?.length
            ? current
            : {
                ...current,
                [id]: history.turns.length
                  ? turnsFromHistory(id, history.turns)
                  : imported,
              },
        );
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        // A conversation with no stored log yet is simply empty.
        if ((reason as { status?: number }).status === 404) {
          loaded.current.add(id);
          return;
        }
        setHistoryRequest({
          id,
          state: "error",
          message:
            reason instanceof MessageError &&
            typeof reason.text !== "string" &&
            reason.text.namespace === "conversation" &&
            reason.text.key === "historyReadTimeout"
              ? message("historyTimedOut")
              : message("historyFailed"),
        });
      })
      .finally(() => {
        if (!abort.signal.aborted)
          setHistoryRequest((current) =>
            current?.id === id && current.state === "loading"
              ? undefined
              : current,
          );
      });
    return () => abort.abort();
  }, [endpoint, sessionId, forkFrom, imported, historyRetry]);

  // Detach local observers when the pane unmounts; execution is backend-owned.
  useEffect(() => {
    const live = streams.current;
    const requests = guidanceRequests.current;
    return () => {
      for (const { controller } of live.values()) controller.abort();
      for (const abort of requests.values()) abort.abort();
    };
  }, []);

  /**
   * Stops the shown conversation's turn. Aborting the local stream alone is
   * not enough: after a reload there is no local stream, and the backend
   * may not notice a dropped connection, so the backend is told directly.
   */
  const stop = async () => {
    if (!sessionId || stopping) return;
    const id = sessionId;
    setStopping(true);
    setError("");
    try {
      if (awaitingService.current.has(id)) {
        streams.current.get(id)?.controller.abort();
        return;
      }
      const execution = conversations.view(endpoint, id).snapshot?.execution;
      if (execution && isExecutionActive(execution)) {
        const commandId = crypto.randomUUID();
        await conversations.submit(endpoint, id, {
          commandId,
          type: "turn.stop",
          executionId: execution.id,
        });
        const receipt = await conversations.wait(
          endpoint,
          id,
          commandId,
          new AbortController().signal,
        );
        if (receipt.status !== "applied")
          throw new MessageError(
            apiErrorText(
              receipt.errorDetails,
              receipt.error ?? message("stopUnknown"),
            ),
          );
      } else if (compacting) {
        await stopCodingTurn(endpoint, id);
      } else {
        throw new MessageError(message("executionUnknown"));
      }
      await conversations.refresh(endpoint, id);
    } catch (reason) {
      setError(message("stopFailed", { reason: errorMessage(reason) }));
    } finally {
      setStopping(false);
    }
  };

  const noticeKey = [
    error,
    historyError,
    guidanceState?.phase,
    slowPending === pendingCommand ? pendingCommand : undefined,
    remote.connection,
  ]
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("|");
  useEffect(() => {
    if (nearBottom.current && windowEnd === shown.length)
      transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [shown, windowEnd, noticeKey]);

  const older = async () => {
    if (!sessionId || olderLoading) return;
    if (windowStart > 0) {
      setHistoryWindow({ id: sessionId, end: windowStart });
      transcript.current?.scrollTo({ top: 0 });
      return;
    }
    const page = historyPages[sessionId];
    if (!page?.hasMore) return;
    const id = sessionId;
    const abort = new AbortController();
    olderRequest.current?.abort();
    olderRequest.current = abort;
    setOlderLoading(true);
    try {
      const history = await conversationHistory(
        endpoint,
        id,
        abort.signal,
        page,
      );
      if (abort.signal.aborted) return;
      const previous = turnsFromHistory(id, history.turns);
      setHistoryPages((current) => ({
        ...current,
        [id]: {
          hasMore: history.hasMore,
          beforeSeq: history.beforeSeq,
          throughSeq: history.throughSeq,
        },
      }));
      setTurns((current) => ({
        ...current,
        [id]: mergeConversationSteers([
          ...new Map(
            [...previous, ...(current[id] ?? [])].map((turn) => [
              turn.id,
              turn,
            ]),
          ).values(),
        ]),
      }));
      setHistoryWindow({ id, end: previous.length });
      transcript.current?.scrollTo({ top: 0 });
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(errorMessage(reason, message("olderFailed")));
    } finally {
      if (!abort.signal.aborted) setOlderLoading(false);
    }
  };

  // A search match scrolls to its turn once, loading older pages as needed.
  const focusDone = useRef<number | undefined>(undefined);
  const [focusedTurn, setFocusedTurn] = useState<string>();
  useEffect(() => {
    if (
      !focus ||
      focus.conversationId !== sessionId ||
      focusDone.current === focus.key ||
      loadingHistory ||
      olderLoading
    )
      return;
    const index = focusTurnIndex(shown, focus.seq);
    if (index === undefined) {
      if (historyPages[sessionId]?.hasMore) void older();
      else focusDone.current = focus.key;
      return;
    }
    if (index < windowStart || index >= windowEnd) {
      setHistoryWindow({
        id: sessionId,
        end: Math.min(shown.length, index + 20),
      });
      return;
    }
    focusDone.current = focus.key;
    const id = shown[index]!.id;
    nearBottom.current = false;
    const node = transcript.current?.querySelector<HTMLElement>(
      `[data-turn-id="${CSS.escape(id)}"]`,
    );
    node?.scrollIntoView({ block: "start" });
    setFocusedTurn(id);
    const timer = setTimeout(() => setFocusedTurn(undefined), 2_000);
    return () => clearTimeout(timer);
    // `older` changes every render; the guards above keep this single-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focus,
    sessionId,
    shown,
    loadingHistory,
    olderLoading,
    historyPages,
    windowStart,
    windowEnd,
  ]);

  const updateTurn = useCallback(
    (id: string, turnId: string, change: (turn: Turn) => Turn) =>
      setTurns((current) => {
        const turns = current[id] ?? noTurns;
        const index = turns.findIndex((turn) => turn.id === turnId);
        const previous = turns[index];
        if (!previous) return current;
        const updated = change(previous);
        if (updated === previous) return current;
        const next = turns.slice();
        next[index] = updated;
        return { ...current, [id]: next };
      }),
    [],
  );
  const runningTurnId = shown.find((turn) => turn.status === "running")?.id;

  /** Sends an answer; the card shows it once the backend accepted it. */
  const answer = useCallback(
    async (
      _turnId: string,
      questionId: string,
      answers: CodingQuestionAnswer[],
    ) => {
      if (!sessionId) return;
      const execution = conversations.view(endpoint, sessionId).snapshot
        ?.execution;
      if (!execution || !isExecutionActive(execution))
        throw new MessageError(message("executionEnded"));
      const commandId = crypto.randomUUID();
      await conversations.submit(endpoint, sessionId, {
        commandId,
        type: "question.answer",
        executionId: execution.id,
        questionId,
        answers,
      });
      const receipt = await conversations.wait(
        endpoint,
        sessionId,
        commandId,
        new AbortController().signal,
      );
      if (receipt.status !== "applied")
        throw new MessageError(
          apiErrorText(
            receipt.errorDetails,
            receipt.error ?? message("answerUnknown"),
          ),
        );
    },
    [endpoint, sessionId],
  );

  // Capture the displayed defaults for both new turns and in-flight guidance.
  const submittedModelConfig = (): ChatModelSelection => {
    const catalog = modelCatalogs.snapshot(endpoint, mode).catalog;
    const chosenModel = modelConfig.model ?? catalog?.defaultModel;
    const chosenEffort =
      modelConfig.reasoningEffort ??
      catalog?.models.find((model) => model.id === chosenModel)
        ?.defaultReasoningEffort;
    return {
      ...(chosenModel ? { model: chosenModel } : {}),
      ...(chosenEffort ? { reasoningEffort: chosenEffort } : {}),
    };
  };

  /**
   * Sends guidance into the running turn. DSH joins it to that turn, which
   * picks it up at its next step boundary, so the model changes course with
   * its work so far intact. Show the submission immediately and match the
   * stream's read event to that same entry.
   */
  const steer = async (text: string, attached: ChatImage[]) => {
    const retry = guidanceState?.phase === "retry";
    const turnId = retry ? guidanceState.turnId : runningTurnId;
    // An image-only message is allowed, as it is for a turn.
    if (
      !projectId ||
      !sessionId ||
      !turnId ||
      readOnly ||
      offline ||
      images.uploading ||
      awaitingService.current.has(sessionId) ||
      guidanceRequests.current.has(sessionId) ||
      (!text.trim() && !attached.length)
    )
      return false;
    const id = sessionId;
    const requestId = retry ? undefined : crypto.randomUUID();
    const stream = streams.current.get(id);
    const abort = new AbortController();
    guidanceRequests.current.set(id, abort);
    const updateGuidance = (phase?: GuidanceState["phase"]) =>
      setGuidance((current) => ({
        ...current,
        [id]: phase ? { phase, turnId } : undefined,
      }));
    updateGuidance(retry ? "checking" : "sending");
    setError("");
    try {
      if (requestId) {
        nearBottom.current = true;
        setHistoryWindow(undefined);
        updateTurn(id, turnId, (turn) =>
          addPendingSteer(turn, requestId, text.trim(), attached),
        );
        const execution = conversations.view(endpoint, id).snapshot?.execution;
        if (!execution || !isExecutionActive(execution))
          throw new MessageError(message("executionEnded"));
        await conversations.submit(endpoint, id, {
          commandId: requestId,
          type: "turn.steer",
          executionId: execution.id,
          prompt: text,
          images: attached.map((image) => image.assetId),
          modelConfig: { mode, selection: submittedModelConfig() },
        });
        const receipt = await conversations.wait(
          endpoint,
          id,
          requestId,
          abort.signal,
        );
        const steered = receipt.status === "applied";
        if (receipt.status === "uncertain")
          throw new MessageError(
            apiErrorText(
              receipt.errorDetails,
              receipt.error ?? message("steerUnknown"),
            ),
          );
        abort.signal.throwIfAborted();
        if (steered) {
          updateTurn(id, turnId, (turn) =>
            settlePendingSteer(turn, requestId, "queued"),
          );
          setDraft((current) => (current === text ? "" : current));
          for (const item of images.attachments)
            if (item.image) images.detach(item.key);
          updateGuidance();
          return true;
        }
        updateTurn(id, turnId, (turn) => settlePendingSteer(turn, requestId));
      }
      updateGuidance("checking");
      try {
        const recorded = await waitForCodingTurnEnd(endpoint, id, abort.signal);
        abort.signal.throwIfAborted();
        const checkedAt = Date.now();
        if (
          stream &&
          stream.turnId === turnId &&
          streams.current.get(id) === stream
        )
          stream.reconcile(recorded, checkedAt);
        else
          updateTurn(id, turnId, (turn) =>
            reconcileFinishedTurn(turn, recorded, checkedAt),
          );
        updateGuidance("ready");
        onSettled?.();
      } catch {
        if (!abort.signal.aborted) updateGuidance("retry");
      }
      return false;
    } catch (reason) {
      if (abort.signal.aborted) return false;
      const rejected =
        reason instanceof WorkflowApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        reason.status !== 408;
      if (requestId)
        updateTurn(id, turnId, (turn) =>
          settlePendingSteer(
            turn,
            requestId,
            rejected ? undefined : "unconfirmed",
          ),
        );
      updateGuidance();
      setError(
        message(rejected ? "sendFailedReason" : "steerUnknownReason", {
          reason: errorMessage(reason),
        }),
      );
      return false;
    } finally {
      guidanceRequests.current.delete(id);
    }
  };

  const send: ConversationSend = async (
    text = draft,
    attached = images.ready,
    options,
  ) => {
    const prompt = text.trim();
    const intent = options?.intent;
    if ((intent === "goal" || intent === "resume-goal") && attached.length) {
      setError(message("goalTextOnly"));
      return undefined;
    }
    if (
      (!prompt && !attached.length) ||
      remote.pending !== undefined ||
      running ||
      images.uploading ||
      historyBlocked ||
      readOnly ||
      permissionSaving ||
      collaborationSaving ||
      !!goal?.armed ||
      (sessionId !== undefined && guidanceRequests.current.has(sessionId)) ||
      guidanceState?.phase === "retry" ||
      sending.current.has(draftKey) ||
      !projectId ||
      offline
    )
      return undefined;
    const abort = new AbortController();
    sending.current.set(draftKey, abort);
    // Side chats use a prefix the backend requires, so they never collide
    // with an indexed conversation.
    const id = sessionId ?? `${forkFrom ? "side" : "coding"}-${newId()}`;
    // A brand-new conversation has no stored log to read back.
    if (!sessionId) loaded.current.add(id);
    const turnId = newId();
    if (options?.preserveDraft && !sessionId) {
      moveDraft(id);
      images.moveTo(id);
    }
    const submittedConfig = submittedModelConfig();
    if (intent)
      setDraftIntents((current) => ({ ...current, [draftKey]: undefined }));
    onOpen?.(id, submittedConfig);
    setError("");
    if (guidanceState?.phase === "ready")
      setGuidance((current) => ({ ...current, [id]: undefined }));
    if (!options?.preserveDraft) {
      setDraft("");
      images.clear();
    }
    // Mirrors the state updates so the finished turn can be returned.
    let latest = newTurn(turnId, prompt, Date.now(), attached);
    if (preparing) latest.waitingForService = true;
    let reconciled = false;
    const change = (next: (turn: Turn) => Turn) => {
      if (reconciled) return;
      latest = next(latest);
      updateTurn(id, turnId, next);
    };
    setTurns((current) => ({
      ...current,
      [id]: [...(current[id] ?? (id === sessionId ? imported : [])), latest],
    }));
    const stream: ConversationStream = {
      controller: abort,
      turnId,
      reconcile(recorded, checkedAt) {
        change((turn) => reconcileFinishedTurn(turn, recorded, checkedAt));
        // The host is idle, so a stale stream can be detached before it closes.
        reconciled = true;
        if (sending.current.get(draftKey) === abort)
          sending.current.delete(draftKey);
        abort.abort();
      },
    };
    streams.current.set(id, stream);
    // The sidebar lists the conversation as soon as its session exists.
    const listed = setTimeout(() => onSettled?.(), 1_500);
    try {
      if (preparing) {
        awaitingService.current.add(id);
        try {
          await prepareCodingTurn(endpoint, projectId, abort.signal);
        } finally {
          awaitingService.current.delete(id);
        }
        change((turn) => ({ ...turn, waitingForService: false }));
      }
      abort.signal.throwIfAborted();
      const commandId = crypto.randomUUID();
      await conversations.submit(endpoint, id, {
        commandId,
        type: "turn.start",
        input: {
          projectId,
          prompt,
          images: attached.map((image) => image.assetId),
          ...(forkFrom ? { forkFrom } : {}),
          ...(branchFrom ? { branchFrom } : {}),
          ...(branchAt !== undefined ? { branchAt } : {}),
          ...(history ? { history } : {}),
          ...(context ? { context } : {}),
          mode,
          modelConfig: submittedConfig,
          ...(draftPermission ? { permission: draftPermission } : {}),
          ...(intent ? { intent } : {}),
        },
      });
      const receipt = await conversations.wait(
        endpoint,
        id,
        commandId,
        abort.signal,
      );
      const snapshot = conversations.view(endpoint, id).snapshot;
      const restored = snapshot && turnsFromHistory(id, snapshot.turns);
      if (restored?.length) latest = restored.at(-1)!;
      if (receipt.status === "rejected" || receipt.status === "uncertain")
        setError(
          apiErrorText(
            receipt.errorDetails,
            receipt.error ?? message("executionCheckConversation"),
          ),
        );
    } catch (reason) {
      if (!abort.signal.aborted) {
        setError(errorMessage(reason, message("executionReconnect")));
        if (
          reason instanceof WorkflowApiError &&
          reason.status >= 400 &&
          reason.status < 500
        ) {
          setTurns((current) => ({
            ...current,
            [id]: (current[id] ?? []).filter((turn) => turn.id !== turnId),
          }));
          setDraft((current) => current || prompt);
        }
        void conversations.refresh(endpoint, id).catch(() => undefined);
      }
    } finally {
      if (sending.current.get(draftKey) === abort)
        sending.current.delete(draftKey);
      clearTimeout(listed);
      if (streams.current.get(id) === stream) streams.current.delete(id);
      onSettled?.();
    }
    return latest;
  };

  /**
   * What the composer does with the draft: a turn in progress takes it as
   * guidance, anything else starts a turn. Only the composer routes this way;
   * `send` stays the new-turn path its programmatic callers expect.
   */
  const resumeGoal = () =>
    goal &&
    !goal.armed &&
    goal.phase !== "complete" &&
    goal.roundsStarted < goal.maxGoalRounds
      ? send(goal.objective, [], { preserveDraft: true, intent: "resume-goal" })
      : undefined;
  const submit = async () => {
    const directive = collaborationCommand(draft);
    if (directive && !offline && !readOnly) {
      if (directive.action === "pause") {
        if (!goal?.armed) return false;
        await stop();
        setDraft("");
        return true;
      }
      if (pending || running || goal?.armed) return false;
      if (directive.action === "execute" || directive.action === "clear") {
        const changed = await chooseCollaboration(
          directive.action === "clear" ? "clear-goal" : "execute",
        );
        if (changed) setDraft("");
        return changed;
      }
      if (directive.action === "resume") {
        if (await resumeGoal()) {
          setDraft((current) => (current === draft ? "" : current));
          return true;
        }
        return false;
      }
      if (directive.action === "goal" && goal && goal.phase !== "complete") {
        setError(message("goalExists"));
        return false;
      }
      if ("prompt" in directive)
        return Boolean(
          await send(directive.prompt, images.ready, {
            intent: directive.action,
          }),
        );
    }
    if (pending) return Promise.resolve(false);
    if (commands.submitCommand()) return false;
    return running || guidanceState?.phase === "retry"
      ? steer(draft, images.ready)
      : send(draft, images.ready, { intent: draftIntent }).then(Boolean);
  };

  // The host and the hand-off read the latest `send` through refs, so typing
  // does not re-run their effects.
  const latestSend = useRef(send);
  useEffect(() => {
    latestSend.current = send;
    if (sendRef) sendRef.current = (...args) => latestSend.current(...args);
  });
  // Deferred so a mount that is immediately torn down (StrictMode re-runs
  // effects) neither sends twice nor has its unmount abort the first send.
  useEffect(() => {
    if (!initialSend) return;
    const timer = setTimeout(() => {
      onInitialSendTaken?.();
      void latestSend.current(initialSend.prompt, initialSend.images ?? []);
    });
    return () => clearTimeout(timer);
  }, [initialSend, onInitialSendTaken]);

  const stopControl = (
    <button
      type="button"
      className="icon-control composer-stop"
      aria-label={stopping ? t("stopping") : t("stop")}
      title={stopping ? t("stopping") : t("stop")}
      disabled={offline || readOnly || stopping}
      onClick={() => void stop()}
    >
      <Square
        size={14}
        fill="currentColor"
        className="aura-icon--filled"
        aria-hidden="true"
      />
    </button>
  );
  const DecisionCard = questionDocked ? QuestionDock : ApprovalCard;

  return (
    // Empty and active conversations share the same bottom-docked composer.
    <div
      className="coding-pane"
      data-phase={!shown.length && !loadingHistory ? "hero" : "active"}
    >
      <div
        className="studio-scroll coding-transcript"
        ref={transcript}
        onScroll={(event) => {
          const node = event.currentTarget;
          nearBottom.current =
            node.scrollHeight - node.clientHeight - node.scrollTop < 100;
        }}
      >
        {windowStart > 0 || (sessionId && historyPages[sessionId]?.hasMore) ? (
          <button
            type="button"
            className="tool-button"
            disabled={olderLoading}
            onClick={() => void older()}
          >
            {olderLoading ? t("loadingOlder") : t("viewOlder")}
          </button>
        ) : null}
        {!shown.length ? (
          loadingHistory || empty ? (
            <div className="coding-empty">
              {loadingHistory ? <p>{t("loadingHistory")}</p> : empty}
            </div>
          ) : null
        ) : (
          visibleTurns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              latest={turn.id === shown.at(-1)?.id}
              highlighted={turn.id === focusedTurn}
              visible={visible}
              directory={directory}
              endpoint={endpoint}
              dockedQuestionId={
                pending?.turnId === turn.id
                  ? pending.asked.questionId
                  : undefined
              }
              onAnswer={readOnly ? undefined : answer}
              onApplyFlow={onApplyFlow}
              hideFlowSvg={onFlowReply !== undefined}
              onRepeatFlow={readOnly ? undefined : repeatFlow}
              onForkTurn={readOnly ? undefined : onForkTurn}
            />
          ))
        )}
        {/* Notices follow the latest message instead of covering the pane top. */}
        <div className="coding-notices">
          {compactNotice ? (
            <p role="status" className="coding-notice">
              {messageText(compactNotice, i18n)}
              {compacting ? (
                <button type="button" onClick={() => void stop()}>
                  {t("stopCompacting")}
                </button>
              ) : null}
            </p>
          ) : null}

          {sessionId &&
          !offline &&
          remote.connection !== "online" &&
          remote.connection !== "waiting" ? (
            <p className="coding-notice" role="status">
              {remote.connection === "unsupported"
                ? t("updateRequired")
                : remote.connection === "connecting"
                  ? t("connectingConversation")
                  : t("recoveringConversation")}
              {remote.connection === "unsupported" ? (
                <button
                  type="button"
                  onClick={() => conversations.reconnect(endpoint, sessionId)}
                >
                  {t("reconnect")}
                </button>
              ) : null}
            </p>
          ) : null}
          {remote.snapshot?.execution?.status === "interrupted" ? (
            <p className="coding-notice" role="status">
              {t("hostRestarted")}
            </p>
          ) : null}
          {pendingCommand && slowPending === pendingCommand && sessionId ? (
            <p className="coding-notice" role="status">
              {t("checkingCommand")}
              <button
                type="button"
                onClick={() =>
                  void conversations
                    .retryPending(endpoint, sessionId)
                    .catch((reason: unknown) =>
                      setError(errorMessage(reason, message("queryFailed"))),
                    )
                }
              >
                {t("retryOriginal")}
              </button>
            </p>
          ) : null}
          {error ? (
            <p className="coding-notice" role="alert">
              {messageText(error, i18n)}
            </p>
          ) : null}
          {guidanceState?.phase === "checking" ? (
            <p className="coding-notice" role="status">
              {t("steerChecking")}
            </p>
          ) : guidanceState?.phase === "retry" ? (
            <p className="coding-notice" role="alert">
              {t("steerRetry")}
            </p>
          ) : guidanceState?.phase === "ready" ? (
            <p className="coding-notice" role="status">
              {t("steerReady")}
            </p>
          ) : null}
          {historyError ? (
            <div className="coding-notice" role="alert">
              <span>{messageText(historyError, i18n)}</span>{" "}
              <button
                type="button"
                className="tool-button"
                onClick={() => setHistoryRetry((value) => value + 1)}
              >
                {t("retryRead")}
              </button>
            </div>
          ) : null}
        </div>
        {windowEnd < shown.length && sessionId ? (
          <div className="coding-history-navigation">
            <button
              type="button"
              className="tool-button"
              onClick={() =>
                setHistoryWindow({
                  id: sessionId,
                  end: Math.min(shown.length, windowEnd + 40),
                })
              }
            >
              {t("viewLater")}
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={() => {
                nearBottom.current = true;
                setHistoryWindow(undefined);
              }}
            >
              {t("backLatest")}
            </button>
          </div>
        ) : null}
      </div>
      {readOnly ? (
        <p className="composer-footnote">{t("archivedResume")}</p>
      ) : null}
      <div
        className="chat-composer-area"
        style={readOnly ? { display: "none" } : undefined}
      >
        {composerExtra}
        {goal ? (
          <section className="coding-goal" aria-label={t("currentGoal")}>
            <div className="coding-goal-detail">
              <strong title={goal.objective}>{goal.objective}</strong>
              <span role="status">
                {goal.armed
                  ? t("goalRunning")
                  : goal.phase === "complete"
                    ? t("completed")
                    : goal.phase === "blocked"
                      ? t("goalBlocked")
                      : goal.phase === "paused"
                        ? t("goalPaused")
                        : t("goalReady")}
                {" · "}
                {t("goalRounds", {
                  started: goal.roundsStarted,
                  total: goal.maxGoalRounds,
                })}
              </span>
            </div>
            {!readOnly && !offline ? (
              <div className="coding-goal-actions">
                {goal.armed ? (
                  <button
                    type="button"
                    className="tool-button"
                    disabled={stopping}
                    onClick={() => void stop()}
                  >
                    {t("pauseGoal")}
                  </button>
                ) : (
                  <>
                    {goal.phase !== "complete" ? (
                      <button
                        type="button"
                        className="tool-button"
                        disabled={
                          running ||
                          collaborationSaving ||
                          goal.roundsStarted >= goal.maxGoalRounds
                        }
                        onClick={() => void resumeGoal()}
                      >
                        {t("resumeGoal")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="tool-button"
                      disabled={running || collaborationSaving}
                      onClick={() => void chooseCollaboration("clear-goal")}
                    >
                      {t("clearGoal")}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </section>
        ) : null}
        {flowForm && !questionDocked ? (
          <WorkflowRunForm
            key={`${draftKey}:${flowForm.flow.id}`}
            id={flowFormId}
            title={t("runHere")}
            subtitle={flowTitle(flowForm.flow)}
            schema={flowForm.flow.inputSchema}
            text={flowForm.text}
            onTextChange={(text) =>
              setFlowForms((current) => ({
                ...current,
                [draftKey]: { ...flowForm, text },
              }))
            }
            endpoint={endpoint}
            initialMode={flowForm.mode}
            locked={
              running ||
              historyBlocked ||
              images.uploading ||
              !projectId ||
              offline
            }
            submitting={false}
            submitLabel={t("sendRun")}
            unavailable={!flowForm.flow.available}
            onSubmit={(input, runMode) => {
              if (
                running ||
                historyBlocked ||
                images.uploading ||
                !projectId ||
                offline
              )
                return;
              const prompt = flowConversationPrompt(
                flowForm.flow,
                input,
                runMode,
              );
              if (prompt.length > 80_000) {
                setError(message("flowInputLong"));
                return;
              }
              closeFlow();
              void send(prompt, [], { preserveDraft: true });
            }}
            onClose={closeFlow}
          />
        ) : null}
        {images.error ? (
          <p className="composer-attach-error" role="alert">
            {messageText(images.error, i18n)}
          </p>
        ) : null}
        {images.attachments.map((item) =>
          item.error ? (
            <p key={item.key} className="composer-attach-error" role="alert">
              {item.name} · {messageText(item.error, i18n)}
            </p>
          ) : null,
        )}
        {pending ? (
          <DecisionCard
            key={pending.asked.questionId}
            asked={pending.asked}
            active={visible}
            stopControl={stopControl}
            onAnswer={(answers) =>
              answer(pending.turnId, pending.asked.questionId, answers)
            }
          />
        ) : null}
        <div
          ref={composer}
          hidden={questionDocked}
          className={`chat-composer${dragging ? " dragging" : ""}`}
          onPaste={(event) => {
            const files = pastedImages(event.clipboardData);
            if (!files.length) return;
            event.preventDefault();
            if (offline) {
              images.setError(message("demoNoImages"));
              return;
            }
            images.attach(files);
          }}
          onDragOver={(event) => {
            if (offline || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(event) => {
            if (offline) return;
            event.preventDefault();
            setDragging(false);
            images.attach(event.dataTransfer.files);
          }}
        >
          {images.attachments.length ? (
            <div
              className="composer-attachments"
              aria-label={t("attachedImages")}
            >
              {images.attachments.map((item) => (
                <figure
                  key={item.key}
                  className={`composer-attachment${item.error ? " failed" : ""}`}
                  title={messageText(item.error ?? item.name, i18n)}
                >
                  <button
                    type="button"
                    className="composer-attachment-open"
                    aria-label={t("viewLargeImage", { name: item.name })}
                    onClick={() => setPreviewKey(item.key)}
                  >
                    <img src={item.preview} alt={item.name} />
                  </button>
                  {!item.image && !item.error ? (
                    <span className="composer-attachment-state" role="status">
                      <LoaderCircle size={16} className="coding-spin" />
                      <span className="sr-only">
                        {t("uploadingImage", { name: item.name })}
                      </span>
                    </span>
                  ) : null}
                  {item.error ? (
                    <span
                      className="composer-attachment-state"
                      aria-hidden="true"
                    >
                      !
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    aria-label={t("removeImage", { name: item.name })}
                    onClick={() => images.detach(item.key)}
                  >
                    <X size={12} />
                  </button>
                </figure>
              ))}
              {previewKey &&
              images.attachments.some((item) => item.key === previewKey) ? (
                <ImageLightbox
                  images={images.attachments.map((item) => ({
                    key: item.key,
                    src: item.preview,
                    name: item.name,
                  }))}
                  initial={previewKey}
                  close={() => setPreviewKey(undefined)}
                />
              ) : null}
            </div>
          ) : null}
          {dragging ? (
            <div className="composer-drop-hint" aria-hidden="true">
              {t("dropImages")}
            </div>
          ) : null}
          <ComposerCommands
            menu={commands}
            anchor={composer}
            flowsLoading={flowsLoading}
          />
          <ComposerEditor
            editor={editor}
            command={commands.command}
            references={commands.references}
            aria-label={label}
            aria-controls={commands.visible ? commands.id : undefined}
            aria-activedescendant={
              commands.visible ? commands.activeId : undefined
            }
            placeholder={placeholder}
            maxLength={80_000}
            value={draft}
            disabled={offline}
            onFocus={(event) => commands.trackSelection(event.currentTarget)}
            onSelect={(event) => commands.trackSelection(event.currentTarget)}
            onChange={(event) => commands.changeDraft(event.currentTarget)}
            onCompositionStart={() => commands.setComposing(true)}
            onCompositionEnd={(event) => {
              commands.trackSelection(event.currentTarget);
              commands.setComposing(false);
            }}
            onKeyDown={(event) => {
              if (commands.handleKey(event)) return;
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-tools coding-composer-tools">
            <div className="composer-leading">
              <WorkbenchMenu
                label={t("addAttachmentTool")}
                className="icon-control composer-add-trigger"
                items={[
                  {
                    id: "image",
                    label: t("addImages"),
                    icon: <ImagePlus size={15} />,
                    disabled: offline || images.full,
                    action: () => fileInput.current?.click(),
                  },
                  {
                    id: "commands",
                    label: t("commandsSkillsFlows"),
                    icon: <Terminal size={15} />,
                    shortcut: "/",
                    disabled: offline || !projectId,
                    action: commands.toggle,
                  },
                ]}
              >
                <Plus size={16} aria-hidden="true" />
              </WorkbenchMenu>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) images.attach(event.target.files);
                  event.target.value = "";
                }}
              />
              {/* Mode chips sit with the attach control on the left, as in DSH. */}
              {!offline ? (
                <WorkbenchMenu
                  label={t("permissionsLabel", {
                    permissions: permission
                      ? t(PERMISSION_OPTIONS[permission].detail)
                      : t("defaultPermissions"),
                  })}
                  className={`composer-context composer-permission${permission === "danger-full-access" ? " danger" : ""}`}
                  disabled={readOnly || !onPermission || permissionSaving}
                  items={CODING_PERMISSIONS.map((preset) => ({
                    id: preset,
                    label: t(PERMISSION_OPTIONS[preset].detail),
                    icon: React.createElement(PERMISSION_OPTIONS[preset].Icon, {
                      size: 14,
                      "aria-hidden": true,
                    }),
                    selected: preset === permission,
                    danger: preset === "danger-full-access",
                    action: () => {
                      setError("");
                      void onPermission?.(preset).catch(() =>
                        setError(message("permissionSaveFailed")),
                      );
                    },
                  }))}
                >
                  {React.createElement(
                    permission
                      ? PERMISSION_OPTIONS[permission].Icon
                      : ShieldCheck,
                    { size: 14, "aria-hidden": true },
                  )}
                  <span>
                    {permission
                      ? t(PERMISSION_OPTIONS[permission].label)
                      : t("defaultPermissions")}
                  </span>
                  <ChevronDown size={12} aria-hidden="true" />
                </WorkbenchMenu>
              ) : null}
              {composerLeading}
            </div>
            <div className="composer-trailing">
              {visible && flags?.voice && !questionDocked && !readOnly ? (
                <VoiceInput
                  key={draftKey}
                  endpoint={endpoint}
                  onText={(text) => {
                    setDraft((current) =>
                      current.trim() ? `${current.trimEnd()} ${text}` : text,
                    );
                    editor.current?.focus();
                  }}
                />
              ) : null}
              <ChatModelControls
                endpoint={endpoint}
                mode={mode}
                selection={modelConfig}
                disabled={readOnly || steering}
                openRequest={modelOpenRequest}
                note={running ? t("nextMessageModel") : undefined}
                onChange={onModelConfig}
                onModeChange={
                  running
                    ? undefined
                    : (next) => onProvider(next === "demo" ? "offline" : next)
                }
              />
              {/* Empty running drafts stop; content switches the same slot to send. */}
              {running && !draft.trim() && !images.attachments.length ? (
                stopControl
              ) : (
                <button
                  className="send-button"
                  aria-label={
                    guidanceState?.phase === "retry"
                      ? t("recheckTurn")
                      : running
                        ? t("sendGuidance")
                        : t("send")
                  }
                  title={
                    running && guidanceState?.phase !== "retry"
                      ? t("guidanceHint")
                      : undefined
                  }
                  disabled={
                    offline ||
                    !projectId ||
                    historyBlocked ||
                    readOnly ||
                    (!running && permissionSaving) ||
                    collaborationSaving ||
                    steering ||
                    (running &&
                      !!sessionId &&
                      awaitingService.current.has(sessionId)) ||
                    !!pending ||
                    (!draft.trim() && !images.ready.length) ||
                    images.uploading
                  }
                  onClick={() => void submit()}
                >
                  <ArrowUp
                    size={16}
                    className="aura-icon--emphasis"
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
          </div>
        </div>
        {collaboration?.planning && !draftIntent ? (
          <p className="composer-footnote" role="status">
            {t("planModeHint")}
          </p>
        ) : null}
        {footnote ? <p className="composer-footnote">{footnote}</p> : null}
      </div>
    </div>
  );
}
