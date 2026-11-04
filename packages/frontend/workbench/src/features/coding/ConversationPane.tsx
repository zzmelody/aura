import { SubagentPanel } from "./SubagentPanel.tsx";
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
  useLayoutEffect,
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
import { collaborationCommand } from "./composer-commands";
import {
  ArrowUp,
  Check,
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
import { writeClipboard } from "../../clipboard";
import type { ChatImage } from "@aura/core/types";
import { chatImageUrl } from "../../chatImages";
import { ImageLightbox, ImageThumbnails } from "../../ImageLightbox";
import { pastedImages, useImageAttachments } from "../../useImageAttachments";
import { WorkflowApiError } from "../../workflowSessions";
import {
  codingTurn,
  conversationHistory,
  answerQuestion,
  steerCodingTurn,
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
  answerTurn,
  applyTurnEvent,
  confirmConversationSteer,
  confirmRecordedSteers,
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
  const { lines } = fileDiff(diff);
  return (
    <div className="coding-diff">
      <pre aria-label={`${diff.path} 的改动`}>
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
  running: { icon: LoaderCircle, label: "执行中" },
  ok: { icon: CircleCheck, label: "已完成" },
  failed: { icon: CircleX, label: "失败" },
  stopped: { icon: CircleStop, label: "已中断" },
};

/** DSH-style tool identity and expandable diff, with an explicit outcome. */
function ToolRow({ tool }: { tool: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcons[tool.name] ?? Wrench;
  const title = toolLabels[tool.name] ?? tool.name;
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
          <span className="coding-diff-added">+{totals.added}</span>{" "}
          <span className="coding-diff-removed">-{totals.removed}</span>
        </span>
      ) : null}
      <span className={`coding-tool-state ${tool.state}`}>
        <StateIcon
          size={13}
          className={tool.state === "running" ? "coding-spin" : undefined}
          aria-hidden="true"
        />
        <span>{stateLabel}</span>
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

const toolLabels: Record<string, string> = {
  read: "读取文件",
  read_image: "查看图片",
  write: "写入文件",
  edit: "编辑文件",
  glob: "查找文件",
  grep: "搜索内容",
  bash: "运行命令",
  pwsh: "运行命令",
  todo_write: "更新任务清单",
  present: "交付文件",
  exit_plan_mode: "提交计划",
  get_goal: "读取目标",
  update_goal: "更新目标",
  ask_user_question: "向你提问",
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
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
  const id = useId();
  const summary = summarizeToolGroup(tools);
  if (!summary.total) return null;
  const description = summary.active
    ? `正在${toolLabels[summary.active.name] ?? "调用工具"}`
    : describeToolGroup(tools);
  const Icon = summary.active ? LoaderCircle : Wrench;
  return (
    <section
      className={`coding-tool-group ${summary.state}`}
      aria-label="工具调用组"
      data-coding-process-record
    >
      <button
        type="button"
        className="coding-tool-group-toggle"
        aria-expanded={expanded}
        aria-controls={id}
        title={`${description} · ${summary.total} 次工具调用 · 点击${expanded ? "收起" : "展开"}详情`}
        onClick={onToggle}
      >
        <Icon
          size={15}
          className={summary.state === "running" ? "coding-spin" : undefined}
        />
        <span className="coding-tool-group-title">{description}</span>
        {summary.failed ? (
          <span className="coding-tool-group-failed">
            {summary.failed} 项失败
          </span>
        ) : null}
        {summary.stopped ? (
          <span className="coding-tool-group-stopped">
            {summary.stopped} 项中断
          </span>
        ) : null}
        <ChevronRight size={12} className="coding-tool-group-chevron" />
      </button>
      <ol
        id={id}
        className="coding-tools"
        aria-label="操作记录"
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

/** The transcript trace of one approval request. */
function ApprovalNote({
  asked,
  live,
}: {
  asked: AskedQuestion;
  live: boolean;
}) {
  const question = asked.questions[0];
  const { allow } = approvalLabels(asked);
  const granted = asked.answered?.some((answer) =>
    answer.selected.includes(allow),
  );
  const state = asked.answered
    ? granted
      ? { Icon: ShieldCheck, text: "已允许", tone: "" }
      : { Icon: ShieldX, text: "已拒绝", tone: " rejected" }
    : live
      ? { Icon: ShieldAlert, text: "等待你授权", tone: "" }
      : { Icon: ShieldX, text: "授权请求已结束", tone: " rejected" };
  return (
    <div
      className={`coding-approval-note${state.tone}`}
      title={question?.detail ?? question?.question}
    >
      <state.Icon aria-hidden="true" />
      <span>{state.text}</span>
      {question ? <span>· {question.question}</span> : null}
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const waiting = useRef(false);
  const composing = useRef(false);
  const compositionEnded = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const question = asked.questions[0];
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
      setError(reason instanceof Error ? reason.message : String(reason));
      waiting.current = false;
      setSending(false);
    }
  };
  return (
    <div
      ref={root}
      className="coding-decision approval"
      role="region"
      aria-label="授权请求"
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
        等待审批
      </div>
      <div className="coding-decision-body">
        <div className="coding-decision-headline">{question.question}</div>
        {question.detail ? (
          <div className="coding-decision-detail">{question.detail}</div>
        ) : null}
      </div>
      <div className="coding-decision-actions">
        <button
          type="button"
          className="reject"
          disabled={sending}
          onClick={() => void answer(labels.reject)}
        >
          {labels.reject}
        </button>
        <button
          type="button"
          className="allow"
          disabled={sending}
          onClick={() => void answer(labels.allow)}
        >
          {labels.allow}
        </button>
      </div>
      {error ? (
        <p className="coding-decision-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The answer recorded for one question of a batch. */
function answerText(asked: AskedQuestion, id: string) {
  const answer = asked.answered?.find((item) => item.id === id);
  if (!answer) return "未回答";
  return (
    [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(
      "、",
    ) || "已跳过"
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
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
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
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      waiting.current = false;
      setSending(false);
    }
  };
  return (
    <section
      className={`coding-question${bare ? " bare" : ""}`}
      aria-label="模型的提问"
    >
      <h3>
        <MessageCircleQuestion size={14} />
        {plan ? "请审阅计划" : "需要你的决定"}
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
                  <small>批准后开始实施</small>
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
              aria-label={`${question.question} 的其他回答`}
              placeholder={
                question.intent
                  ? "或者写下要修改的地方"
                  : question.options?.length
                    ? "或者写下你的回答"
                    : "写下你的回答"
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
          发送回答
        </button>
      </div>
      {error ? (
        <p className="coding-error" role="alert">
          {error}
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
  const settled = asked.answered !== undefined;
  const summary = asked.questions
    .map((question) => question.question)
    .join("；");
  return (
    <details className="coding-question-note">
      <summary title={summary}>
        <MessageCircleQuestion size={14} aria-hidden="true" />
        <span className="coding-question-note-state">
          {settled ? "已回答" : live ? "等待你的回答" : "提问已结束"}
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
              {question.header ? `${question.header}：` : ""}
              {question.question}
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
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) root.current?.focus();
  }, [active, asked.questionId]);
  return (
    <div
      ref={root}
      className="coding-decision question"
      role="region"
      aria-label="等待你的回答"
      tabIndex={-1}
    >
      <div className="coding-decision-strip">
        <span className="coding-decision-dot" aria-hidden="true" />
        等待你的回答
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
  const [note, setNote] = useState("");
  const reveal = globalThis.window?.auraHost?.files?.reveal;
  const full = fullPath(path, directory);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), 2000);
    return () => clearTimeout(timer);
  }, [note]);
  const run = async (action: () => Promise<void>, done: string) => {
    try {
      await action();
      setNote(done);
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <li data-row-highlight>
      <FileText size={13} />
      <code title={full}>{path}</code>
      <span className="coding-report-actions">
        <button
          className="icon-control row-control"
          aria-label={`复制 ${path} 的完整路径`}
          title="复制完整路径"
          onClick={() => void run(() => writeClipboard(full), "已复制")}
        >
          <Copy size={13} />
        </button>
        {reveal ? (
          <button
            className="icon-control row-control"
            aria-label={`在文件夹中显示 ${path}`}
            title="在文件夹中显示"
            onClick={() => void run(() => reveal(directory, path), "已定位")}
          >
            <FolderSearch size={13} />
          </button>
        ) : null}
      </span>
      {note ? (
        <span className="coding-report-note" role="status">
          {note}
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
  if (!images?.length) return null;
  return (
    <ImageThumbnails
      className="message-images coding-prompt-images"
      images={images.map((image) => ({
        key: image.assetId,
        src: chatImageUrl(endpoint, image.assetId),
        name: image.name ?? "附图",
      }))}
    />
  );
}

const TurnView = memo(function TurnView({
  turn,
  latest,
  visible,
  directory,
  endpoint,
  dockedQuestionId,
  onAnswer,
  onApplyFlow,
  onRepeatFlow,
  onForkTurn,
}: {
  turn: Turn;
  latest: boolean;
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
  onForkTurn?(endSeq: number): void;
}) {
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
      ? "正在连接本地服务，可停止等待"
      : waiting
        ? "等待你的回答"
        : "执行中"
    : turn.status === "complete"
      ? "执行完成"
      : turn.status === "stopped"
        ? "已停止"
        : "执行失败";
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
                ? `${expanded ? "收起" : "展开"}${canCollapse ? "执行记录" : "工具明细"}`
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
              {turn.tools.length ? ` · ${turn.tools.length} 次工具调用` : null}
              {foldedTools?.failed ? (
                <span className="coding-tool-group-failed">
                  {` · ${foldedTools.failed} 项失败`}
                </span>
              ) : null}
              {foldedTools?.stopped ? (
                <span className="coding-tool-group-stopped">
                  {` · ${foldedTools.stopped} 项中断`}
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
                  aria-label="任务进度"
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
                  {turn.progress.done}/{turn.progress.total} 项任务
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
              {item.text}
            </p>
          );
        if (item.kind === "web")
          return (
            <aside key={index} className="coding-web-sources">
              <span>
                网页来源
                {item.event.statusCode
                  ? ` · HTTP ${item.event.statusCode}`
                  : ""}
                {item.event.truncated ? " · 结果已截断" : ""}
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
              <WorkflowRichText text={item.text} />
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
                  ? "送达状态未确认"
                  : running
                    ? "等待 Agent 读取"
                    : "本轮结束前未确认读取"}
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
          放入工作流编辑器
        </button>
      ) : null}
      {turn.error ? (
        <p className="coding-error" role="alert">
          {turn.error}
        </p>
      ) : null}
      {turn.deliverables.length ? (
        <section className="coding-report" aria-label="交付文件">
          <h3>交付文件</h3>
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
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), 2000);
    return () => clearTimeout(timer);
  }, [note]);
  const reveal = globalThis.window?.auraHost?.files?.reveal;
  const run = async (action: () => Promise<void>, done: string) => {
    try {
      await action();
      setNote(done);
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return {
    note,
    copy: (path: string) =>
      void run(() => writeClipboard(fullPath(path, directory)), "已复制路径"),
    ...(reveal
      ? {
          reveal: (path: string) =>
            void run(() => reveal(directory, path), "已在文件夹中显示"),
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
        {created ? <span className="coding-recap-badge">新文件</span> : null}
        <span className="coding-recap-counts">
          {binary ? (
            <span>二进制</span>
          ) : (
            <>
              <span className="coding-diff-added">+{added}</span>
              <span className="coding-diff-removed">-{removed}</span>
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
                  aria-label={`${open ? "收起" : "查看"} ${fileName(shown)} 的改动`}
                  aria-expanded={open}
                  title={open ? "收起改动" : "查看改动"}
                  onClick={() => setOpen((value) => !value)}
                >
                  <FileDiff size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-control row-control"
                aria-label={`复制 ${fileName(shown)} 的完整路径`}
                title="复制完整路径"
                onClick={() => actions.copy(path)}
              >
                <Copy size={14} />
              </button>
              {actions.reveal ? (
                <button
                  type="button"
                  className="icon-control row-control"
                  aria-label={`在文件夹中显示 ${fileName(shown)}`}
                  title="在文件夹中显示"
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
      aria-label="文件改动"
      data-coding-process-record
    >
      <h3 className="coding-recap-title">文件改动</h3>
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
          {expanded ? "收起" : `全部 ${files.length} 个文件`}
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
  const now = useTicker(turn.status === "running" && visible);
  return duration((turn.endedAt ?? now) - turn.startedAt);
}

/** Sends one request; resolves with the finished turn, or nothing if refused. */
export type ConversationSend = (
  text?: string,
  attached?: ChatImage[],
  options?: { preserveDraft?: boolean; intent?: CodingRunIntent },
) => Promise<Turn | undefined>;

const PERMISSION_OPTIONS = {
  "read-only": { label: "只读", detail: "只读 · 写入需审批" },
  "workspace-write": { label: "工作区写入", detail: "工作区写入 · 越界需审批" },
  "danger-full-access": {
    label: "完全访问",
    detail: "完全访问 · 无沙箱限制，无需审批",
  },
} satisfies Record<CodingPermission, { label: string; detail: string }>;

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
  onForkTurn,
  history,
  historyTime = 0,
  context,
  initialDraft,
  onDraftChange,
  onAttachmentsChange,
  draftInsert,
  onApplyFlow,
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
  onForkTurn?(endSeq: number): void;
  history?: ChatMessage[];
  historyTime?: number;
  context?: string;
  initialDraft?: string;
  onDraftChange?(draft: string): void;
  onAttachmentsChange?(attached: boolean): void;
  draftInsert?: { id: string; text: string };
  onApplyFlow?(code: string): void;
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
  const [turns, setTurns] = useState<Record<string, Turn[]>>({});
  const draftKey =
    sessionId ??
    (branchFrom ? `fork:${branchFrom}:${branchAt ?? "latest"}` : "draft");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[draftKey] ?? initialDraft ?? "";
  const { flags } = useIntegrations();
  const setDraft = useCallback(
    (value: React.SetStateAction<string>) =>
      setDrafts((current) => ({
        ...current,
        [draftKey]:
          typeof value === "function"
            ? value(current[draftKey] ?? initialDraft ?? "")
            : value,
      })),
    [draftKey, initialDraft],
  );
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [error, setError] = useState("");
  const [collaborations, setCollaborations] = useState<
    Partial<Record<string, CodingCollaboration>>
  >({});
  const [draftIntents, setDraftIntents] = useState<
    Partial<Record<string, CodingRunIntent>>
  >({});
  const [collaborationSaving, setCollaborationSaving] = useState(false);
  const collaboration = sessionId ? collaborations[sessionId] : undefined;
  const goal = collaboration?.goal;
  const draftIntent = draftIntents[draftKey];
  const selectedMode =
    draftIntent === "goal" || goal?.armed
      ? "goal"
      : (draftIntent ? draftIntent === "plan" : collaboration?.planning)
        ? "plan"
        : "execute";
  const modeLabel =
    selectedMode === "goal"
      ? "目标"
      : selectedMode === "plan"
        ? "计划"
        : "执行";
  const [historyRequest, setHistoryRequest] = useState<{
    id: string;
    state: "loading" | "error";
    message?: string;
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
  // Only the oldest open batch in this conversation owns the dock.
  const pending = useMemo(
    () => (readOnly ? undefined : pendingQuestion(shown)),
    [readOnly, shown],
  );
  const questionDocked = pending !== undefined && !isApproval(pending.asked);
  useLayoutEffect(() => {
    const textarea = editor.current;
    if (!textarea || questionDocked) return;
    const fit = () => {
      // A hidden pane measures 0; keep the CSS minimum instead of 0px.
      if (!textarea.clientWidth) {
        textarea.style.height = "";
        return;
      }
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    fit();
    // A side pane can first measure while it is still sliding open and very
    // narrow; re-fit when its width settles so the height does not stay huge.
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      fit();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [draft, questionDocked]);
  const windowEnd =
    historyWindow && historyWindow.id === sessionId
      ? Math.min(historyWindow.end, shown.length)
      : shown.length;
  const windowStart = Math.max(0, windowEnd - 40);
  const visibleTurns = shown.slice(windowStart, windowEnd);
  const running = shown.some((turn) => turn.status === "running");
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
    Record<string, { busy: boolean; text: string }>
  >({});
  const compacting = compactStates[sessionId ?? ""]?.busy ?? false;
  const compactNotice = compactStates[sessionId ?? ""]?.text ?? "";
  async function compact() {
    const id = sessionId ?? "";
    const update = (busy: boolean, text: string) =>
      setCompactStates((current) => ({ ...current, [id]: { busy, text } }));
    if (!id) {
      update(false, "发送消息后才能压缩上下文。");
      return;
    }
    if (compacting || running) return;
    update(true, "正在压缩较早的上下文…");
    try {
      const result = await compactCoding(endpoint, id);
      update(
        false,
        result.compacted
          ? `已压缩 ${result.replacedMessages} 条上下文（约节省 ${result.savedTokens ?? 0} tokens），原始聊天记录仍然保留。`
          : "还没有可压缩的上下文。",
      );
    } catch (cause) {
      update(false, cause instanceof Error ? cause.message : "压缩未完成。");
    }
  }
  const chooseCollaboration = async (
    action: CodingCollaborationAction | "goal",
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
    if (action === "goal" && goal && goal.phase !== "complete") {
      setError("这段对话已有目标，请先继续或清除它。");
      return false;
    }
    if (
      action === "goal" ||
      !sessionId ||
      (!shown.length && !collaboration?.planning && !goal)
    ) {
      if (action !== "clear-goal")
        setDraftIntents((current) => ({ ...current, [draftKey]: action }));
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
      setError(reason instanceof Error ? reason.message : "协作模式更新失败。");
      return false;
    } finally {
      setCollaborationSaving(false);
    }
  };
  const commands = useComposerCommands({
    endpoint,
    projectId,
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
      else if (command === "plan" || command === "goal")
        void chooseCollaboration(command);
      else editor.current?.focus();
    },
  });
  useEffect(() => {
    if (initialDraft !== undefined) setDraft(initialDraft);
  }, [initialDraft, setDraft]);
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
            reason instanceof Error && reason.message.includes("读取超时")
              ? "会话历史读取超时，草稿已保留，请重试。"
              : "会话历史读取失败，草稿已保留，请重试。",
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

  // Stop in-flight turns when the pane unmounts.
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
    streams.current.get(id)?.controller.abort();
    try {
      if (awaitingService.current.has(id)) return;
      await stopCodingTurn(endpoint, id);
      if (goal) {
        const state = await readCodingCollaboration(endpoint, id).catch(
          () => undefined,
        );
        if (state)
          setCollaborations((current) => ({ ...current, [id]: state }));
      }
      // A turn restored from history has no stream to settle it.
      setTurns((current) => ({
        ...current,
        [id]: (current[id] ?? []).map((turn) =>
          turn.status === "running"
            ? finishTurn(turn, "stopped", Date.now())
            : turn,
        ),
      }));
    } catch (reason) {
      setError(
        `停止失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setStopping(false);
    }
  };

  useEffect(() => {
    if (nearBottom.current && windowEnd === shown.length)
      transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [shown, windowEnd]);

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
      const previous = turnsFromHistory(
        `${id}:${history.beforeSeq}`,
        history.turns,
      );
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
        [id]: [...previous, ...(current[id] ?? [])],
      }));
      setHistoryWindow({ id, end: previous.length });
      transcript.current?.scrollTo({ top: 0 });
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "较早记录读取失败，请重试。",
        );
    } finally {
      if (!abort.signal.aborted) setOlderLoading(false);
    }
  };

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

  useEffect(() => {
    if (
      !visible ||
      !sessionId ||
      !runningTurnId ||
      streams.current.has(sessionId)
    )
      return;
    const abort = new AbortController();
    void waitForCodingTurnEnd(
      endpoint,
      sessionId,
      abort.signal,
      (recorded) =>
        updateTurn(sessionId, runningTurnId, (turn) =>
          confirmRecordedSteers(turn, recorded),
        ),
      (state) =>
        setCollaborations((current) => ({ ...current, [sessionId]: state })),
    ).then(
      (recorded) => {
        if (abort.signal.aborted) return;
        const checkedAt = Date.now();
        updateTurn(sessionId, runningTurnId, (turn) =>
          reconcileFinishedTurn(turn, recorded, checkedAt),
        );
      },
      () => {
        if (!abort.signal.aborted) setError("暂时无法读取本轮进度。");
      },
    );
    return () => abort.abort();
  }, [endpoint, sessionId, runningTurnId, updateTurn, visible]);

  /** Sends an answer; the card shows it once the backend accepted it. */
  const answer = useCallback(
    async (
      turnId: string,
      questionId: string,
      answers: CodingQuestionAnswer[],
    ) => {
      if (!sessionId) return;
      await answerQuestion(endpoint, sessionId, questionId, answers);
      setTurns((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).map((turn) =>
          turn.id === turnId ? answerTurn(turn, questionId, answers) : turn,
        ),
      }));
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
        const { steered } = await steerCodingTurn(
          endpoint,
          id,
          text,
          attached.map((image) => image.assetId),
          { mode, selection: submittedModelConfig() },
          abort.signal,
          requestId,
        );
        abort.signal.throwIfAborted();
        if (steered) {
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
        `${rejected ? "发送失败" : "无法确认追加消息是否送达"}：${reason instanceof Error ? reason.message : String(reason)}`,
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
      setError("目标指令需要纯文本。请先在普通消息中发送参考图片。");
      return undefined;
    }
    if (
      (!prompt && !attached.length) ||
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
      setDrafts((current) => {
        const { [draftKey]: previous, ...rest } = current;
        return { ...rest, [id]: previous ?? draft };
      });
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
      for await (const chunk of codingTurn(
        endpoint,
        {
          sessionId: id,
          projectId,
          prompt,
          ...(attached.length
            ? { images: attached.map((image) => image.assetId) }
            : {}),
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
        abort.signal,
      )) {
        if (chunk.type === "collaboration") {
          setCollaborations((current) => ({ ...current, [id]: chunk.state }));
        } else if (chunk.type === "steer" && chunk.requestId && !reconciled) {
          latest = applyTurnEvent(latest, chunk);
          setTurns((current) => ({
            ...current,
            [id]: confirmConversationSteer(current[id] ?? [], turnId, chunk),
          }));
        } else {
          change((turn) => applyTurnEvent(turn, chunk));
        }
      }
      change((turn) =>
        finishTurn(
          turn,
          abort.signal.aborted ? "stopped" : "complete",
          Date.now(),
        ),
      );
    } catch (reason) {
      const stopped = abort.signal.aborted;
      change((turn) =>
        finishTurn(
          turn,
          stopped ? "stopped" : "error",
          Date.now(),
          stopped
            ? undefined
            : reason instanceof Error
              ? reason.message
              : String(reason),
        ),
      );
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
      if ("prompt" in directive)
        return Boolean(
          await send(directive.prompt, images.ready, {
            intent: directive.action,
          }),
        );
    }
    if (pending) return Promise.resolve(false);
    if (commands.submitCommand() || commands.slash !== undefined)
      return Promise.resolve(false);
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
      aria-label={stopping ? "正在停止" : "停止生成"}
      title={stopping ? "正在停止" : "停止生成"}
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
      {compactNotice ? (
        <p role="status" className="coding-notice">
          {compactNotice}
          {compacting ? (
            <button type="button" onClick={() => void stop()}>
              停止压缩
            </button>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <p className="coding-notice" role="alert">
          {error}
        </p>
      ) : null}
      {guidanceState?.phase === "checking" ? (
        <p className="coding-notice" role="status">
          追加未送达，正在确认本轮是否结束。草稿已保留。
        </p>
      ) : guidanceState?.phase === "retry" ? (
        <p className="coding-notice" role="alert">
          暂时无法确认本轮状态。草稿已保留，点击发送可重新确认。
        </p>
      ) : guidanceState?.phase === "ready" ? (
        <p className="coding-notice" role="status">
          本轮已结束。草稿已保留，点击发送开始新一轮。
        </p>
      ) : null}
      {sessionId && !offline && visible ? (
        <SubagentPanel
          key={sessionId}
          endpoint={endpoint}
          sessionId={sessionId}
          running={running}
        />
      ) : null}
      {historyError ? (
        <div className="coding-notice" role="alert">
          <span>{historyError}</span>{" "}
          <button
            type="button"
            className="tool-button"
            onClick={() => setHistoryRetry((value) => value + 1)}
          >
            重试读取
          </button>
        </div>
      ) : null}
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
            {olderLoading ? "正在读取较早记录…" : "查看较早记录"}
          </button>
        ) : null}
        {!shown.length ? (
          loadingHistory || empty ? (
            <div className="coding-empty">
              {loadingHistory ? <p>正在读取这段对话的过程记录…</p> : empty}
            </div>
          ) : null
        ) : (
          visibleTurns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              latest={turn.id === shown.at(-1)?.id}
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
              onRepeatFlow={readOnly ? undefined : repeatFlow}
              onForkTurn={readOnly ? undefined : onForkTurn}
            />
          ))
        )}
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
              查看后续记录
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={() => {
                nearBottom.current = true;
                setHistoryWindow(undefined);
              }}
            >
              返回最新
            </button>
          </div>
        ) : null}
      </div>
      {readOnly ? (
        <p className="composer-footnote">这段对话已归档，取消归档后可继续。</p>
      ) : null}
      <div
        className="chat-composer-area"
        style={readOnly ? { display: "none" } : undefined}
      >
        {composerExtra}
        {goal ? (
          <section className="coding-goal" aria-label="当前目标">
            <div className="coding-goal-detail">
              <strong title={goal.objective}>{goal.objective}</strong>
              <span role="status">
                {goal.armed
                  ? "正在续跑"
                  : goal.phase === "complete"
                    ? "已完成"
                    : goal.phase === "blocked"
                      ? "已阻塞"
                      : goal.phase === "paused"
                        ? "已暂停"
                        : "待继续"}
                {" · "}
                {goal.roundsStarted}/{goal.maxGoalRounds} 轮
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
                    暂停目标
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
                        继续目标
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="tool-button"
                      disabled={running || collaborationSaving}
                      onClick={() => void chooseCollaboration("clear-goal")}
                    >
                      清除目标
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </section>
        ) : draftIntent === "goal" ? (
          <p className="coding-goal-hint">
            下一条纯文本消息将成为目标。续跑使用「对话能力」里的额外请求额度。
          </p>
        ) : null}
        {flowForm && !questionDocked ? (
          <WorkflowRunForm
            key={`${draftKey}:${flowForm.flow.id}`}
            id={flowFormId}
            title="在当前对话中运行"
            subtitle={flowForm.flow.title}
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
            submitLabel="发送运行请求"
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
                setError("工作流输入过长，请缩短后再发送。");
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
            {images.error}
          </p>
        ) : null}
        {images.attachments.map((item) =>
          item.error ? (
            <p key={item.key} className="composer-attach-error" role="alert">
              {item.name} · {item.error}
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
              images.setError(
                "本地演示模式不能附带图片，请切换到 Codex 订阅或其他模式。",
              );
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
            <div className="composer-attachments" aria-label="已附加的图片">
              {images.attachments.map((item) => (
                <figure
                  key={item.key}
                  className={`composer-attachment${item.error ? " failed" : ""}`}
                  title={item.error ?? item.name}
                >
                  <button
                    type="button"
                    className="composer-attachment-open"
                    aria-label={`查看大图 ${item.name}`}
                    onClick={() => setPreviewKey(item.key)}
                  >
                    <img src={item.preview} alt={item.name} />
                  </button>
                  {!item.image && !item.error ? (
                    <span className="composer-attachment-state" role="status">
                      <LoaderCircle size={16} className="coding-spin" />
                      <span className="sr-only">正在上传 {item.name}</span>
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
                    aria-label={`移除图片 ${item.name}`}
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
              松开以添加图片
            </div>
          ) : null}
          <ComposerCommands
            menu={commands}
            anchor={composer}
            flowsLoading={flowsLoading}
          />
          <textarea
            ref={editor}
            aria-label={label}
            aria-controls={commands.visible ? commands.id : undefined}
            aria-activedescendant={
              commands.visible ? commands.activeId : undefined
            }
            placeholder={placeholder}
            maxLength={80_000}
            value={draft}
            disabled={offline}
            onChange={(event) => commands.changeDraft(event.target.value)}
            onKeyDown={(event) => {
              if (commands.handleKey(event)) return;
              if (commands.slash !== undefined && event.key === "Enter") {
                event.preventDefault();
                return;
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-tools coding-composer-tools">
            <div className="composer-leading">
              <WorkbenchMenu
                label="添加附件或工具"
                className="icon-control composer-add-trigger"
                items={[
                  {
                    id: "image",
                    label: "添加图片",
                    icon: <ImagePlus size={15} />,
                    disabled: offline || images.full,
                    action: () => fileInput.current?.click(),
                  },
                  {
                    id: "commands",
                    label: "命令、Skills 和 Flows",
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
              {!offline ? (
                <WorkbenchMenu
                  label={`协作模式 · ${modeLabel}`}
                  className="composer-context composer-mode"
                  disabled={
                    !projectId ||
                    historyBlocked ||
                    readOnly ||
                    running ||
                    !!goal?.armed ||
                    collaborationSaving
                  }
                  items={[
                    {
                      id: "execute",
                      label: "执行模式",
                      action: () => void chooseCollaboration("execute"),
                    },
                    {
                      id: "plan",
                      label: "计划模式 · 先规划，再审阅",
                      action: () => void chooseCollaboration("plan"),
                    },
                    {
                      id: "goal",
                      label: "目标模式 · 按额度自动续跑",
                      disabled: !!goal && goal.phase !== "complete",
                      action: () => void chooseCollaboration("goal"),
                    },
                  ]}
                >
                  {selectedMode === "goal" ? (
                    <Target size={14} aria-hidden="true" />
                  ) : (
                    <ClipboardCheck size={14} aria-hidden="true" />
                  )}
                  <span>{modeLabel}</span>
                  <ChevronDown size={12} aria-hidden="true" />
                </WorkbenchMenu>
              ) : null}
              {!offline ? (
                <WorkbenchMenu
                  label={`对话权限 · ${permission ? PERMISSION_OPTIONS[permission].detail : "默认权限"}`}
                  className={`composer-context composer-permission${permission === "danger-full-access" ? " danger" : ""}`}
                  disabled={readOnly || !onPermission || permissionSaving}
                  items={CODING_PERMISSIONS.map((preset) => ({
                    id: preset,
                    label: PERMISSION_OPTIONS[preset].detail,
                    icon:
                      preset === permission ? (
                        <Check size={14} />
                      ) : preset === "danger-full-access" ? (
                        <ShieldAlert size={14} />
                      ) : undefined,
                    danger: preset === "danger-full-access",
                    action: () => {
                      setError("");
                      void onPermission?.(preset).catch(() =>
                        setError("权限保存失败，请检查服务连接后重试。"),
                      );
                    },
                  }))}
                >
                  {permission === "danger-full-access" ? (
                    <ShieldAlert size={14} aria-hidden="true" />
                  ) : (
                    <ShieldCheck size={14} aria-hidden="true" />
                  )}
                  <span>
                    {permission
                      ? PERMISSION_OPTIONS[permission].label
                      : "默认权限"}
                  </span>
                  <ChevronDown size={12} aria-hidden="true" />
                </WorkbenchMenu>
              ) : null}
              <ChatModelControls
                endpoint={endpoint}
                mode={mode}
                selection={modelConfig}
                disabled={readOnly || steering}
                openRequest={modelOpenRequest}
                note={
                  running
                    ? "随下一条消息生效；已发出的请求继续使用原配置。"
                    : undefined
                }
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
                      ? "重新确认本轮状态"
                      : running
                        ? "发送引导"
                        : "发送消息"
                  }
                  title={
                    running && guidanceState?.phase !== "retry"
                      ? "发送引导（模型会在下一步读到）"
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
                    images.uploading ||
                    commands.slash !== undefined
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
        {footnote ? <p className="composer-footnote">{footnote}</p> : null}
      </div>
    </div>
  );
}
