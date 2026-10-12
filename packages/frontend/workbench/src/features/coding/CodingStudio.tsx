import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  FileText,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { providerMode } from "@aura/core";
import type { Workspace } from "@aura/core/types";
import type {
  CodingConversationInfo,
  CodingFileDiff,
  CodingProjectInfo,
} from "@aura/protocol/types";
import {
  chooseWorkflowPath,
  workflowFilePickerAvailable,
} from "../../file-picker";
import { WorkflowRichText } from "../../screens/WorkflowValue";
import {
  codingTurn,
  createProject,
  listConversations,
  listProjects,
  removeProject,
} from "./api";
import { diffLines, diffStats } from "./diff";
import "./coding.css";

type ToolEntry = {
  callId: string;
  name: string;
  /** The file, command or pattern the call touches, when it names one. */
  detail?: string;
  state: "running" | "ok" | "failed";
  /** Applied hunks of a write or edit. */
  diffs?: CodingFileDiff[];
};

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

/** One request and everything the agent did to answer it. */
type Turn = {
  id: string;
  prompt: string;
  reply: string;
  tools: ToolEntry[];
  progress?: { done: number; total: number };
  deliverables: string[];
  status: "running" | "complete" | "stopped" | "error";
  error?: string;
  startedAt: number;
  endedAt?: number;
};

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

function TurnView({ turn, now }: { turn: Turn; now: number }) {
  const elapsed = (turn.endedAt ?? now) - turn.startedAt;
  const running = turn.status === "running";
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
              ? "正在处理"
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
              <li key={path}>
                <FileText size={13} />
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
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

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || !project || running) return;
    const sessionId = conversationId ?? `coding-${newId()}`;
    const turnId = newId();
    setConversationId(sessionId);
    setDraft("");
    setError("");
    setTurns((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        {
          id: turnId,
          prompt,
          reply: "",
          tools: [],
          deliverables: [],
          status: "running",
          startedAt: Date.now(),
        },
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
        updateTurn(sessionId, turnId, (turn) => {
          if (chunk.type === "delta")
            return { ...turn, reply: turn.reply + chunk.text };
          if (chunk.type === "progress")
            return {
              ...turn,
              progress: { done: chunk.done, total: chunk.total },
            };
          if (chunk.type === "deliverable")
            return turn.deliverables.includes(chunk.path)
              ? turn
              : { ...turn, deliverables: [...turn.deliverables, chunk.path] };
          if (chunk.phase === "start")
            return {
              ...turn,
              tools: [
                ...turn.tools,
                {
                  callId: chunk.callId,
                  name: chunk.name,
                  ...(chunk.detail ? { detail: chunk.detail } : {}),
                  state: "running",
                },
              ],
            };
          return {
            ...turn,
            tools: turn.tools.map((tool) =>
              tool.callId === chunk.callId
                ? {
                    ...tool,
                    state: chunk.ok ? "ok" : "failed",
                    ...(chunk.diffs?.length ? { diffs: chunk.diffs } : {}),
                  }
                : tool,
            ),
          };
        });
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
                  ? "这段对话的过程记录只在本次打开期间保留，可以继续发送新的请求。"
                  : `描述你要在「${project.title}」里完成的事情。改动只会写入这个目录。`}
              </p>
            </div>
          ) : (
            shown.map((turn) => (
              <TurnView key={turn.id} turn={turn} now={now} />
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
