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
  FileCheck,
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
import type { Workspace } from "@aura/core/types";
import type {
  ChatModelSelection,
  ChatMessage,
  FlowCatalogEntry,
  FlowRun,
  FlowMode,
  CodingFileDiff,
  CodingQuestionAnswer,
} from "@aura/protocol/types";
import { WorkflowRichText } from "../../screens/WorkflowValue";
import { ChatModelControls } from "../../screens/ChatModelControls";
import { modelCatalogs } from "../../model-catalog-store";
import { WorkbenchMenu } from "../../WorkbenchMenu";
import "./composer.css";
import { writeClipboard } from "../../clipboard";
import type { ChatImage } from "@aura/core/types";
import { chatImageUrl } from "../../chatImages";
import { pastedImages, useImageAttachments } from "../../useImageAttachments";
import {
  codingTurn,
  conversationHistory,
  answerQuestion,
  steerCodingTurn,
  stopCodingTurn,
  prepareCodingTurn,
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
  answerTurn,
  applyTurnEvent,
  finishTurn,
  hasSummary,
  newTurn,
  recapParts,
  summarizeTurn,
  summarizeToolGroup,
  describeToolGroup,
  turnsFromHistory,
  type AskedQuestion,
  type ToolEntry,
  type Turn,
} from "./turns";

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
      className="coding-approval"
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
      <div className="coding-approval-strip">
        <span className="coding-approval-dot" aria-hidden="true" />
        等待审批
      </div>
      <div className="coding-approval-body">
        <div className="coding-approval-headline">{question.question}</div>
        {question.detail ? (
          <div className="coding-approval-detail">{question.detail}</div>
        ) : null}
      </div>
      <div className="coding-approval-actions">
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
        <p className="coding-approval-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One question batch from the agent: open with a form, or its answer once sent. */
function QuestionCard({
  asked,
  live,
  onAnswer,
}: {
  asked: AskedQuestion;
  /** False once the turn ended; the agent is no longer waiting. */
  live: boolean;
  onAnswer(answers: CodingQuestionAnswer[]): Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const done = asked.answered !== undefined;
  const approval = asked.questions.some((item) => item.kind === "approval");
  const plan = asked.questions.some((item) => item.intent);
  // Like DSH, the decision happens in the composer card; the transcript keeps
  // only one quiet line recording what was asked and how it was settled.
  if (approval) return <ApprovalNote asked={asked} live={live} />;
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
      setSending(false);
    }
  };
  const answerText = (id: string) => {
    const answer = asked.answered?.find((item) => item.id === id);
    if (!answer) return "未回答";
    return (
      [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(
        "、",
      ) || "已跳过"
    );
  };
  return (
    <section
      className={`coding-question${done ? " answered" : ""}`}
      aria-label="模型的提问"
    >
      <h3>
        <MessageCircleQuestion size={14} />
        {done
          ? approval
            ? "已处理授权"
            : plan
              ? "已审阅计划"
              : "已回答"
          : !live
            ? "提问已结束"
            : approval
              ? "需要你授权"
              : plan
                ? "请审阅计划"
                : "需要你的决定"}
      </h3>
      {asked.questions.map((question) => (
        <fieldset key={question.id} disabled={done || !live || sending}>
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
          {done ? (
            <p className="coding-question-answer">{answerText(question.id)}</p>
          ) : (
            <>
              {question.options?.map((option) => (
                <label key={option.label} className="coding-question-option">
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`${asked.questionId}-${question.id}`}
                    checked={(selected[question.id] ?? []).includes(
                      option.label,
                    )}
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
                />
              )}
            </>
          )}
        </fieldset>
      ))}
      {!done && live ? (
        <div className="coding-question-actions">
          <button disabled={sending} onClick={() => void submit()}>
            {sending ? (
              <LoaderCircle size={13} className="coding-spin" />
            ) : null}
            发送回答
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="coding-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
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
    <li>
      <FileText size={13} />
      <code title={full}>{path}</code>
      <span className="coding-report-actions">
        <button
          className="icon-control"
          aria-label={`复制 ${path} 的完整路径`}
          title="复制完整路径"
          onClick={() => void run(() => writeClipboard(full), "已复制")}
        >
          <Copy size={13} />
        </button>
        {reveal ? (
          <button
            className="icon-control"
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

const TurnView = memo(function TurnView({
  turn,
  visible,
  directory,
  endpoint,
  onAnswer,
  onApplyFlow,
  onRepeatFlow,
}: {
  turn: Turn;
  visible: boolean;
  /** Runtime endpoint; sent images are served from it. */
  endpoint: string;
  /** Project directory; deliverable paths resolve against it. */
  directory: string;
  onAnswer(
    turnId: string,
    questionId: string,
    answers: CodingQuestionAnswer[],
  ): Promise<void>;
  onApplyFlow?(code: string): void;
  onRepeatFlow?(run: FlowRun): void;
}) {
  const running = turn.status === "running";
  const waiting = turn.questions.some((item) => !item.answered);
  const [open, setOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
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
    <article className="coding-turn">
      {turn.prompt ? <div className="coding-prompt">{turn.prompt}</div> : null}
      {turn.images?.length ? (
        <div className="message-images coding-prompt-images">
          {turn.images.map((image) => (
            <a
              key={image.assetId}
              href={chatImageUrl(endpoint, image.assetId)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={chatImageUrl(endpoint, image.assetId)}
                alt={image.name ?? "附图"}
              />
            </a>
          ))}
        </div>
      ) : null}
      {running || hasSteps || turn.status !== "complete" ? (
        <div className="coding-work" aria-live="polite">
          <button
            type="button"
            className={`coding-process ${turn.status}`}
            aria-expanded={hasSteps ? allExpanded : undefined}
            disabled={!hasSteps}
            data-open={(hasSteps && allExpanded) || undefined}
            title={`${stateLabel} · ${turn.tools.length} 次工具调用`}
            onClick={() => {
              setOpen(!allExpanded);
              setExpandedGroups({});
            }}
          >
            {turn.status !== "complete" ? (
              <StateIcon
                size={15}
                className={`coding-process-icon${running && !waiting ? " coding-spin" : ""}`}
                aria-hidden="true"
              />
            ) : null}
            <span className="coding-process-label">
              {turn.status !== "complete" ? (
                <span className="coding-process-state">{stateLabel} · </span>
              ) : (
                "用时 "
              )}
              <span className="coding-process-number">
                <TurnDuration turn={turn} visible={visible} />
              </span>
            </span>
            {hasSteps ? (
              <ChevronDown
                size={14}
                className="coding-process-chevron"
                aria-hidden="true"
              />
            ) : null}
          </button>
          {open && turn.progress && turn.progress.total > 0 ? (
            <div className="coding-process-body">
              {turn.progress && turn.progress.total > 0 ? (
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
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {turn.timeline.map((item, index) => {
        if (item.kind === "text")
          return item.text.trim() ? (
            <div key={index} className="coding-reply">
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
          // Pending approvals are actionable only in the card above the input.
          if (
            !asked ||
            (!asked.answered &&
              running &&
              asked.questions.some((q) => q.kind === "approval"))
          )
            return null;
          return (
            <QuestionCard
              key={item.questionId}
              asked={asked}
              live={running}
              onAnswer={(answers) =>
                onAnswer(turn.id, asked.questionId, answers)
              }
            />
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
          <div key={index} className="coding-prompt coding-steer">
            {item.text}
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
      {!running ? <TurnSummaryView turn={turn} directory={directory} /> : null}
    </article>
  );
});

/**
 * End-of-turn recap, after DSH's changed-files card: one line of what it did
 * and how long it took, then the files it changed. A single file is just the
 * header; more files fold after four rows.
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
      <div className="coding-recap-file-row">
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
                  className="icon-control"
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
                className="icon-control"
                aria-label={`复制 ${fileName(shown)} 的完整路径`}
                title="复制完整路径"
                onClick={() => actions.copy(path)}
              >
                <Copy size={14} />
              </button>
              {actions.reveal ? (
                <button
                  type="button"
                  className="icon-control"
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

function TurnSummaryView({
  turn,
  directory,
}: {
  turn: Turn;
  directory: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarizeTurn(turn, fileDiff), [turn]);
  if (!hasSummary(summary)) return null;
  const elapsed = (turn.endedAt ?? Date.now()) - turn.startedAt;
  const work = recapParts(summary);
  const totals = summary.files.reduce(
    (sum, file) => ({
      added: sum.added + file.added,
      removed: sum.removed + file.removed,
    }),
    { added: 0, removed: 0 },
  );
  const foldable = summary.files.length > COLLAPSED_FILES;
  const files =
    foldable && !expanded
      ? summary.files.slice(0, COLLAPSED_FILES)
      : summary.files;
  const diffsByPath = new Map<string, CodingFileDiff[]>();
  for (const tool of turn.tools)
    for (const diff of tool.diffs ?? []) {
      const list = diffsByPath.get(diff.path) ?? [];
      list.push(diff);
      diffsByPath.set(diff.path, list);
    }
  // Every changed file has its own row below, so the header names the count
  // and keeps the rest of the work and the time on the quiet second line.
  const changed = summary.files.length > 0;
  const title = changed
    ? `改动了 ${summary.files.length} 个文件`
    : (work[0] ?? `${summary.steps} 次操作`);
  // The title already says what it changed (or the first thing it did).
  const rest = changed
    ? work.filter((part) => !part.startsWith("改动 "))
    : work.slice(1);
  const line = [...rest, `用时 ${duration(elapsed)}`].join(" · ");
  const HeaderIcon = changed ? FileCheck : Wrench;
  return (
    <section className="coding-recap" aria-label="本轮小结">
      <div className="coding-recap-header">
        <span className="coding-recap-tile" aria-hidden="true">
          <HeaderIcon size={18} />
        </span>
        <span className="coding-recap-titles">
          <span className="coding-recap-title">{title}</span>
          <span className="coding-recap-line">{line}</span>
        </span>
        {summary.files.length ? (
          <span className="coding-recap-stat">
            <span className="coding-diff-added">+{totals.added}</span>
            <span className="coding-diff-removed">-{totals.removed}</span>
          </span>
        ) : null}
      </div>
      {files.length ? (
        <ul className="coding-recap-files">
          {files.map((file) => (
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
      ) : null}
      {foldable ? (
        <button
          type="button"
          className="coding-recap-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `全部 ${summary.files.length} 个文件`}
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
  options?: { preserveDraft?: boolean },
) => Promise<Turn | undefined>;

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
  /** Sent once when it changes, for example a hand-off from another page. */
  initialSend?: { prompt: string; images?: ChatImage[] };
  onInitialSendTaken?(): void;
  /** Lets the host send into this conversation. */
  sendRef?: React.RefObject<ConversationSend | undefined>;
  onRunning?(running: boolean): void;
  onTurns?(turns: readonly Turn[]): void;
}) {
  const [turns, setTurns] = useState<Record<string, Turn[]>>({});
  const draftKey = sessionId ?? "draft";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[draftKey] ?? initialDraft ?? "";
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
  const [historyRequest, setHistoryRequest] = useState<{
    id: string;
    state: "loading" | "error";
    message?: string;
  }>();
  const [historyRetry, setHistoryRetry] = useState(0);
  const awaitingService = useRef(new Set<string>());
  const [dragging, setDragging] = useState(false);
  const images = useImageAttachments(endpoint, draftKey);
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
  const controllers = useRef(new Map<string, AbortController>());
  const sending = useRef(new Set<string>());
  const [stopping, setStopping] = useState(false);
  const [steering, setSteering] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = editor.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

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
  const commands = useComposerCommands({
    endpoint,
    projectId,
    draft,
    setDraft,
    flows: flows ?? [],
    running,
    enabled: !!projectId && !offline && !readOnly,
    onFlow: openFlow,
    editor,
    onCommand(command) {
      if (command === "model") setModelOpenRequest((value) => value + 1);
      else if (command === "stop") void stop();
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
      controllers.current.keys(),
    );
    if (retained === turns) return;
    const evicted = new Set(
      Object.keys(turns).filter((id) => !Object.hasOwn(retained, id)),
    );
    for (const id of evicted) loaded.current.delete(id);
    setTurns(retained);
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
    const live = controllers.current;
    return () => {
      for (const abort of live.values()) abort.abort();
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
    controllers.current.get(id)?.abort();
    try {
      if (awaitingService.current.has(id)) return;
      await stopCodingTurn(endpoint, id);
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

  const updateTurn = (
    id: string,
    turnId: string,
    change: (turn: Turn) => Turn,
  ) =>
    setTurns((current) => ({
      ...current,
      [id]: (current[id] ?? []).map((turn) =>
        turn.id === turnId ? change(turn) : turn,
      ),
    }));

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

  // Only this conversation's oldest pending approval owns the decision card.
  const pendingApproval = useMemo(() => {
    for (const turn of shown) {
      if (turn.status !== "running") continue;
      const asked = turn.questions.find(
        (item) =>
          !item.answered &&
          item.questions.some((question) => question.kind === "approval"),
      );
      if (asked) return { turnId: turn.id, asked };
    }
    return undefined;
  }, [shown]);

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
   * its work so far intact. The guidance and whatever the model does with it
   * arrive on the turn's own stream, which is why nothing is added to the
   * transcript here.
   */
  const steer = async (text: string, attached: ChatImage[]) => {
    // An image-only message is allowed, as it is for a turn.
    if (
      !projectId ||
      !sessionId ||
      awaitingService.current.has(sessionId) ||
      steering ||
      (!text.trim() && !attached.length)
    )
      return false;
    setSteering(true);
    setError("");
    try {
      const { steered } = await steerCodingTurn(
        endpoint,
        sessionId,
        text,
        attached.map((image) => image.assetId),
        { mode, selection: submittedModelConfig() },
      );
      if (!steered) {
        // The turn ended between the keystroke and the request; the text is
        // still in the composer, so sending it again starts a new turn.
        setError("这一轮已经结束了，直接发送就好。");
        return false;
      }
      setDraft("");
      images.clear();
      return true;
    } catch (reason) {
      setError(
        `发送失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
      return false;
    } finally {
      setSteering(false);
    }
  };

  const send: ConversationSend = async (
    text = draft,
    attached = images.ready,
    options,
  ) => {
    const prompt = text.trim();
    if (
      (!prompt && !attached.length) ||
      running ||
      images.uploading ||
      historyBlocked ||
      readOnly ||
      sending.current.has(draftKey) ||
      !projectId ||
      offline
    )
      return undefined;
    sending.current.add(draftKey);
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
    onOpen?.(id, submittedConfig);
    setError("");
    if (!options?.preserveDraft) {
      setDraft("");
      images.clear();
    }
    // Mirrors the state updates so the finished turn can be returned.
    let latest = newTurn(turnId, prompt, Date.now(), attached);
    if (preparing) latest.waitingForService = true;
    const change = (next: (turn: Turn) => Turn) => {
      latest = next(latest);
      updateTurn(id, turnId, next);
    };
    setTurns((current) => ({
      ...current,
      [id]: [...(current[id] ?? (id === sessionId ? imported : [])), latest],
    }));
    const abort = new AbortController();
    controllers.current.set(id, abort);
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
          ...(history ? { history } : {}),
          ...(context ? { context } : {}),
          mode,
          modelConfig: submittedConfig,
        },
        abort.signal,
      ))
        change((turn) => applyTurnEvent(turn, chunk));
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
      sending.current.delete(draftKey);
      clearTimeout(listed);
      if (controllers.current.get(id) === abort) controllers.current.delete(id);
      onSettled?.();
    }
    return latest;
  };

  /**
   * What the composer does with the draft: a turn in progress takes it as
   * guidance, anything else starts a turn. Only the composer routes this way;
   * `send` stays the new-turn path its programmatic callers expect.
   */
  const submit = () => {
    if (pendingApproval) return Promise.resolve(false);
    if (commands.submitCommand() || commands.slash !== undefined)
      return Promise.resolve(false);
    return running ? steer(draft, images.ready) : send().then(Boolean);
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

  return (
    // Empty and active conversations share the same bottom-docked composer.
    <div
      className="coding-pane"
      data-phase={!shown.length && !loadingHistory ? "hero" : "active"}
    >
      {error ? (
        <p className="coding-notice" role="alert">
          {error}
        </p>
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
              visible={visible}
              directory={directory}
              endpoint={endpoint}
              onAnswer={answer}
              onApplyFlow={onApplyFlow}
              onRepeatFlow={readOnly ? undefined : repeatFlow}
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
        {flowForm ? (
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
        {pendingApproval ? (
          <ApprovalCard
            key={pendingApproval.asked.questionId}
            asked={pendingApproval.asked}
            active={visible}
            onAnswer={(answers) =>
              answer(
                pendingApproval.turnId,
                pendingApproval.asked.questionId,
                answers,
              )
            }
          />
        ) : null}
        <div
          ref={composer}
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
                  <img src={item.preview} alt={item.name} />
                  {!item.image && !item.error ? (
                    <span className="composer-attachment-state" role="status">
                      <LoaderCircle size={16} className="coding-spin" />
                      <span className="sr-only">正在上传 {item.name}</span>
                    </span>
                  ) : null}
                  {item.error ? (
                    <span className="composer-attachment-state" role="alert">
                      !<span className="sr-only">{item.error}</span>
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`移除图片 ${item.name}`}
                    onClick={() => images.detach(item.key)}
                  >
                    <X size={12} />
                  </button>
                </figure>
              ))}
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
                    strokeWidth={0}
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label={running ? "发送引导" : "发送消息"}
                  title={running ? "发送引导（模型会在下一步读到）" : undefined}
                  disabled={
                    offline ||
                    !projectId ||
                    historyBlocked ||
                    readOnly ||
                    steering ||
                    (running &&
                      !!sessionId &&
                      awaitingService.current.has(sessionId)) ||
                    !!pendingApproval ||
                    (!draft.trim() && !images.ready.length) ||
                    images.uploading ||
                    commands.slash !== undefined
                  }
                  onClick={() => void submit()}
                >
                  <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
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
