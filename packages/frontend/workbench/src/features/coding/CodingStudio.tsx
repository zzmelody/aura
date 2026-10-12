import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  FileText,
  FolderSearch,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Plus,
  Square,
  MessageCircleQuestion,
  Trash2,
  X,
} from "lucide-react";
import { providerMode } from "@aura/core";
import type { Workspace } from "@aura/core/types";
import type {
  CodingConversationInfo,
  CodingFileDiff,
  CodingProjectInfo,
  CodingQuestionAnswer,
} from "@aura/protocol/types";
import {
  chooseWorkflowPath,
  workflowFilePickerAvailable,
} from "../../file-picker";
import { WorkflowRichText } from "../../screens/WorkflowValue";
import { writeClipboard } from "../../clipboard";
import {
  codingTurn,
  createProject,
  listConversations,
  listProjects,
  conversationHistory,
  removeProject,
  answerQuestion,
} from "./api";
import { diffLines, diffStats } from "./diff";
import {
  answerTurn,
  applyTurnEvent,
  hasSummary,
  newTurn,
  summarizeTurn,
  turnsFromHistory,
  type AskedQuestion,
  type Turn,
} from "./turns";
import "./coding.css";

/** One file-change card: path, line counts, and the line diff. */
function DiffCard({ diff }: { diff: CodingFileDiff }) {
  const lines = diffLines(diff.oldText, diff.newText);
  const { added, removed } = diffStats(lines);
  return (
    <details className="coding-diff" open={lines.length <= 40}>
      <summary>
        <code title={diff.path}>{diff.path}</code>
        <span className="coding-diff-added">+{added}</span>
        <span className="coding-diff-removed">−{removed}</span>
      </summary>
      <pre aria-label={`${diff.path} 的改动`}>
        {lines.map((line, index) => (
          <span key={index} className={`coding-diff-line ${line.kind}`}>
            <span aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
            </span>
            {line.text || " "}
            {"\n"}
          </span>
        ))}
      </pre>
    </details>
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

/** Stable empty list so an idle transcript does not re-run its effects. */
const noTurns: Turn[] = [];

const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function shortPath(directory: string): string {
  const parts = directory.split(/[\\/]/u).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : directory;
}

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
  // Relative paths resolve against the project, as the agent declared them.
  const full = /^([a-zA-Z]:[\\/]|[\\/])/u.test(path)
    ? path
    : `${directory.replace(/[\\/]+$/u, "")}/${path}`;
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
        {note ? <span role="status">{note}</span> : null}
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
    </li>
  );
}

function TurnView({
  turn,
  now,
  directory,
  onAnswer,
}: {
  turn: Turn;
  now: number;
  /** Project directory; deliverable paths resolve against it. */
  directory: string;
  onAnswer(questionId: string, answers: CodingQuestionAnswer[]): Promise<void>;
}) {
  const elapsed = (turn.endedAt ?? now) - turn.startedAt;
  const running = turn.status === "running";
  const waiting = turn.questions.some((item) => !item.answered);
  return (
    <article className="coding-turn">
      <div className="coding-prompt">{turn.prompt}</div>
      <div className="coding-work" aria-live="polite">
        <div className="coding-work-meta">
          <span className={`coding-state ${turn.status}`}>
            {running ? (
              <LoaderCircle size={13} className="coding-spin" />
            ) : turn.status === "complete" ? (
              <Check size={13} />
            ) : (
              <X size={13} />
            )}
            {running
              ? waiting
                ? "等待你的回答"
                : "正在处理"
              : turn.status === "complete"
                ? "已完成"
                : turn.status === "stopped"
                  ? "已停止"
                  : "失败"}
          </span>
          <span>用时 {duration(elapsed)}</span>
          {turn.tools.length ? <span>{turn.tools.length} 次操作</span> : null}
        </div>
        {turn.progress && turn.progress.total > 0 ? (
          <div className="coding-progress">
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
        {turn.tools.length ? (
          <ol className="coding-tools" aria-label="操作记录">
            {turn.tools.map((tool) => (
              <li key={tool.callId} className={tool.state}>
                {tool.state === "running" ? (
                  <LoaderCircle size={12} className="coding-spin" />
                ) : tool.state === "ok" ? (
                  <Check size={12} />
                ) : (
                  <X size={12} />
                )}
                <span>{toolLabels[tool.name] ?? tool.name}</span>
                <code title={tool.detail ?? tool.name}>
                  {tool.detail ?? tool.name}
                </code>
                {tool.diffs?.length ? (
                  <div className="coding-diffs">
                    {tool.diffs.map((diff, index) => (
                      <DiffCard key={index} diff={diff} />
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {/* Questions come before the reply: the agent asked, then answered. */}
      {turn.questions.map((asked) => (
        <QuestionCard
          key={asked.questionId}
          asked={asked}
          live={running}
          onAnswer={(answers) => onAnswer(asked.questionId, answers)}
        />
      ))}
      {turn.reply ? (
        <div className="coding-reply">
          <WorkflowRichText text={turn.reply} />
        </div>
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
      {!running ? <TurnSummaryView turn={turn} /> : null}
    </article>
  );
}

/**
 * What a finished turn changed and ran, built from its own recorded steps
 * rather than the model's description of them.
 */
function TurnSummaryView({ turn }: { turn: Turn }) {
  const summary = summarizeTurn(turn, (diff) =>
    diffStats(diffLines(diff.oldText, diff.newText)),
  );
  if (!hasSummary(summary)) return null;
  return (
    <section className="coding-summary" aria-label="本轮小结">
      <h3>本轮小结</h3>
      {summary.files.length ? (
        <div>
          <h4>改动了 {summary.files.length} 个文件</h4>
          <ul>
            {summary.files.map((file) => (
              <li key={file.path}>
                <code title={file.path}>{file.path}</code>
                <span className="coding-diff-added">+{file.added}</span>
                <span className="coding-diff-removed">−{file.removed}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.commands.length ? (
        <div>
          <h4>运行了 {summary.commands.length} 条命令</h4>
          <ul>
            {summary.commands.map((item, index) => (
              <li key={index} className={item.ok ? "ok" : "failed"}>
                {item.ok ? <Check size={12} /> : <X size={12} />}
                <code title={item.command}>{item.command}</code>
                <span>{item.ok ? "成功" : "失败"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.failedSteps || summary.unanswered ? (
        <p className="coding-summary-note">
          {[
            summary.failedSteps ? `${summary.failedSteps} 个步骤失败` : "",
            summary.unanswered ? `${summary.unanswered} 个问题未回答` : "",
          ]
            .filter(Boolean)
            .join("，")}
        </p>
      ) : null}
    </section>
  );
}

export function CodingStudio({
  endpoint,
  provider,
  onBack,
}: {
  endpoint: string;
  provider: Workspace["provider"];
  onBack(): void;
}) {
  const [projects, setProjects] = useState<CodingProjectInfo[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [conversations, setConversations] = useState<CodingConversationInfo[]>(
    [],
  );
  const [conversationId, setConversationId] = useState<string>();
  const [turns, setTurns] = useState<Record<string, Turn[]>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  /** Conversations already read from the log; a live turn is never overwritten. */
  const loaded = useRef(new Set<string>());
  const controller = useRef<AbortController | undefined>(undefined);
  const transcript = useRef<HTMLDivElement>(null);

  const project = projects.find((item) => item.id === projectId);
  const shown = conversationId ? (turns[conversationId] ?? noTurns) : noTurns;
  const running = shown.some((turn) => turn.status === "running");
  const now = useTicker(running);
  const offline = provider === "offline";
  const desktopPicker = workflowFilePickerAvailable();

  const refreshProjects = useCallback(
    async (signal?: AbortSignal) => {
      const list = await listProjects(endpoint, signal);
      setProjects(list);
      setProjectId((current) =>
        current && list.some((item) => item.id === current)
          ? current
          : list[0]?.id,
      );
    },
    [endpoint],
  );

  useEffect(() => {
    if (offline) return;
    const abort = new AbortController();
    refreshProjects(abort.signal).catch((reason: unknown) => {
      if (!abort.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => abort.abort();
  }, [offline, refreshProjects]);

  useEffect(() => {
    if (!projectId) {
      setConversations([]);
      return;
    }
    const abort = new AbortController();
    listConversations(endpoint, projectId, abort.signal)
      .then(setConversations)
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => abort.abort();
  }, [endpoint, projectId]);

  // Opening a stored conversation reads its transcript back from the log, so
  // a reload or another device shows the same steps, diffs and answers.
  // Conversations started in this page already hold their live turns.
  useEffect(() => {
    if (!conversationId || loaded.current.has(conversationId)) return;
    const sessionId = conversationId;
    const abort = new AbortController();
    setLoadingHistory(true);
    conversationHistory(endpoint, sessionId, abort.signal)
      .then((history) => {
        loaded.current.add(sessionId);
        setTurns((current) =>
          // A turn sent while history was loading wins over the snapshot.
          current[sessionId]?.length
            ? current
            : {
                ...current,
                [sessionId]: turnsFromHistory(sessionId, history.turns),
              },
        );
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        // A conversation with no stored log yet is simply empty.
        if ((reason as { status?: number }).status === 404) {
          loaded.current.add(sessionId);
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoadingHistory(false);
      });
    return () => abort.abort();
  }, [endpoint, conversationId]);

  // Stop an in-flight turn when the studio unmounts.
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [shown]);

  const addProject = async (directory: string) => {
    const value = directory.trim();
    if (!value) return;
    setError("");
    try {
      const created = await createProject(endpoint, value);
      await refreshProjects();
      setProjectId(created.id);
      setConversationId(undefined);
      setAdding(false);
      setPathInput("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const pickDirectory = async () => {
    setError("");
    try {
      const chosen = await chooseWorkflowPath("directory");
      if (chosen) await addProject(chosen);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const forgetProject = async (id: string) => {
    if (
      !window.confirm(
        "从 Aura 移除这个项目？目录里的文件和对话记录都不会被删除。",
      )
    )
      return;
    try {
      await removeProject(endpoint, id);
      if (id === projectId) setConversationId(undefined);
      await refreshProjects();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const updateTurn = (
    sessionId: string,
    turnId: string,
    change: (turn: Turn) => Turn,
  ) =>
    setTurns((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((turn) =>
        turn.id === turnId ? change(turn) : turn,
      ),
    }));

  /** Sends an answer; the card shows it once the backend accepted it. */
  const answer =
    (sessionId: string, turnId: string) =>
    async (questionId: string, answers: CodingQuestionAnswer[]) => {
      await answerQuestion(endpoint, sessionId, questionId, answers);
      updateTurn(sessionId, turnId, (turn) =>
        answerTurn(turn, questionId, answers),
      );
    };

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || !project || running) return;
    const sessionId = conversationId ?? `coding-${newId()}`;
    // A brand-new conversation has no stored log to read back.
    if (!conversationId) loaded.current.add(sessionId);
    const turnId = newId();
    setConversationId(sessionId);
    setDraft("");
    setError("");
    setTurns((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        newTurn(turnId, prompt, Date.now()),
      ],
    }));
    const abort = new AbortController();
    controller.current = abort;
    try {
      for await (const chunk of codingTurn(
        endpoint,
        {
          sessionId,
          projectId: project.id,
          prompt,
          mode: providerMode(provider),
        },
        abort.signal,
      )) {
        updateTurn(sessionId, turnId, (turn) => applyTurnEvent(turn, chunk));
      }
      updateTurn(sessionId, turnId, (turn) => ({
        ...turn,
        status: "complete",
        endedAt: Date.now(),
      }));
    } catch (reason) {
      const stopped = abort.signal.aborted;
      updateTurn(sessionId, turnId, (turn) => ({
        ...turn,
        status: stopped ? "stopped" : "error",
        endedAt: Date.now(),
        ...(stopped
          ? {}
          : {
              error: reason instanceof Error ? reason.message : String(reason),
            }),
      }));
    } finally {
      if (controller.current === abort) controller.current = undefined;
      listConversations(endpoint, project.id)
        .then(setConversations)
        .catch(() => {});
    }
  };

  return (
    <section className="coding-studio studio-shell" aria-label="编码模式">
      <aside className="studio-rail" aria-label="编码项目">
        <div className="studio-rail-heading">
          <span>项目</span>
          <button
            className="icon-control"
            aria-label="添加项目"
            title="添加项目"
            disabled={offline}
            onClick={() =>
              desktopPicker ? void pickDirectory() : setAdding(true)
            }
          >
            <FolderPlus size={15} />
          </button>
        </div>
        <div className="studio-rail-list">
          {projects.map((item) => (
            <div
              key={item.id}
              className={`coding-project${item.id === projectId ? " selected" : ""}`}
            >
              <button
                className={`studio-rail-item${item.id === projectId ? " selected" : ""}`}
                aria-current={item.id === projectId ? "true" : undefined}
                disabled={running}
                onClick={() => {
                  if (item.id === projectId) return;
                  setProjectId(item.id);
                  setConversationId(undefined);
                }}
              >
                <strong>{item.title}</strong>
                <span title={item.directory}>{shortPath(item.directory)}</span>
              </button>
              <button
                className="icon-control coding-project-remove"
                aria-label={`移除项目 ${item.title}`}
                title="移除项目"
                disabled={running}
                onClick={() => void forgetProject(item.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!projects.length && !offline ? (
            <p className="studio-rail-empty">添加一个本机目录作为项目</p>
          ) : null}
          {project ? (
            <>
              <div className="studio-rail-heading coding-conversation-heading">
                <span>对话</span>
                <button
                  className="icon-control"
                  aria-label="新对话"
                  title="新对话"
                  disabled={running}
                  onClick={() => setConversationId(undefined)}
                >
                  <Plus size={15} />
                </button>
              </div>
              {conversations.map((item) => (
                <button
                  key={item.id}
                  className={`studio-rail-item${item.id === conversationId ? " selected" : ""}`}
                  aria-current={item.id === conversationId ? "true" : undefined}
                  disabled={running}
                  onClick={() => setConversationId(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {new Date(item.updatedAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </button>
              ))}
              {!conversations.length ? (
                <p className="studio-rail-empty">还没有对话</p>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>
      <div className="studio-main">
        <header className="studio-toolbar">
          <button
            className="icon-control studio-back"
            aria-label="返回对话"
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="studio-title">
            <strong>{project?.title ?? "编码模式"}</strong>
            <span title={project?.directory}>
              {project ? project.directory : "选择或添加一个项目开始"}
            </span>
          </div>
          {/* The rail is hidden on narrow screens; these controls replace it. */}
          <div className="studio-project-select">
            <button
              className="icon-control"
              aria-label="添加项目"
              title="添加项目"
              disabled={offline || running}
              onClick={() =>
                desktopPicker ? void pickDirectory() : setAdding(true)
              }
            >
              <FolderPlus size={15} />
            </button>
          </div>
          {projects.length ? (
            <label className="studio-project-select">
              <span className="sr-only">选择项目</span>
              <select
                value={projectId ?? ""}
                disabled={running}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setConversationId(undefined);
                }}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {project ? (
            <label className="studio-project-select">
              <span className="sr-only">选择对话</span>
              <select
                value={conversationId ?? ""}
                disabled={running}
                onChange={(event) =>
                  setConversationId(event.target.value || undefined)
                }
              >
                <option value="">新对话</option>
                {conversations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </header>
        {adding ? (
          <form
            className="coding-add"
            onSubmit={(event) => {
              event.preventDefault();
              void addProject(pathInput);
            }}
          >
            <FolderOpen size={15} />
            <input
              aria-label="项目目录的绝对路径"
              placeholder="粘贴 Aura 服务端可访问的绝对路径，例如 /Users/me/project"
              value={pathInput}
              autoFocus
              onChange={(event) => setPathInput(event.target.value)}
            />
            <button type="submit" disabled={!pathInput.trim()}>
              添加
            </button>
            <button
              type="button"
              className="icon-control"
              aria-label="取消"
              onClick={() => setAdding(false)}
            >
              <X size={14} />
            </button>
          </form>
        ) : null}
        {error ? (
          <p className="coding-notice" role="alert">
            {error}
          </p>
        ) : null}
        <div className="studio-scroll coding-transcript" ref={transcript}>
          {offline ? (
            <div className="coding-empty">
              <p>
                编码模式需要连接 Aura 服务。请在对话页切换到 DSH 演示或 Codex
                模式。
              </p>
            </div>
          ) : !project ? (
            <div className="coding-empty">
              <p>
                编码模式在一个本机目录里工作：读写代码、运行命令，并把过程实时展示给你。
              </p>
              <button
                onClick={() =>
                  desktopPicker ? void pickDirectory() : setAdding(true)
                }
              >
                <FolderPlus size={15} />
                添加项目
              </button>
            </div>
          ) : !shown.length ? (
            <div className="coding-empty">
              <p>
                {conversationId
                  ? loadingHistory
                    ? "正在读取这段对话的过程记录…"
                    : "这段对话还没有记录，可以继续发送新的请求。"
                  : `描述你要在「${project.title}」里完成的事情。改动只会写入这个目录。`}
              </p>
            </div>
          ) : (
            shown.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                now={now}
                directory={project.directory}
                onAnswer={answer(conversationId!, turn.id)}
              />
            ))
          )}
        </div>
        {project && !offline ? (
          <div className="chat-composer-area">
            <div className="chat-composer">
              <textarea
                aria-label="编码请求输入框"
                placeholder="例如：给登录页加上表单校验，并跑一遍相关测试"
                maxLength={80_000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-tools">
                <span className="composer-spacer" />
                <button
                  className="send-button"
                  aria-label={running ? "停止" : "发送"}
                  disabled={!running && !draft.trim()}
                  onClick={() =>
                    running ? controller.current?.abort() : void send()
                  }
                >
                  {running ? (
                    <Square size={14} fill="currentColor" />
                  ) : (
                    <ArrowUp size={18} />
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
