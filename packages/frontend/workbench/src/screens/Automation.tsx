import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AutomationHistory,
  AutomationTask,
  AutomationTaskInput,
  AutomationTiming,
  AutomationTimingInput,
} from "@aura/protocol/types";
import { AlarmClock, Plus, RefreshCw, Search, X } from "lucide-react";
import {
  automationHistory,
  createAutomation,
  deleteAutomation,
  listAutomation,
  updateAutomation,
} from "../features/coding/api";
import type { CodingProjectsController } from "../features/coding/useCodingProjects";
import "./automation.css";

type Filter = "all" | "active" | "ended";
const filters: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "运行中" },
  { id: "ended", label: "已结束" },
];
const weekdayNames = ["一", "二", "三", "四", "五", "六", "日"];
const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

function problem(cause: unknown): string {
  return cause instanceof Error ? cause.message : "自动化任务暂时不可用。";
}

/** "每天 09:00", "每 30 分钟", "cron 0 9 * * 1-5". */
export function timingLabel(timing: AutomationTiming): string {
  switch (timing.kind) {
    case "at":
      return `一次 · ${new Date(timing.at).toLocaleString("zh-CN")}`;
    case "after":
      return `一次 · ${Math.round(timing.afterSeconds / 60)} 分钟后`;
    case "every":
      return timing.everySeconds % 3_600 === 0
        ? `每 ${timing.everySeconds / 3_600} 小时`
        : `每 ${Math.round(timing.everySeconds / 60)} 分钟`;
    case "daily":
      return `每天 ${clockIn(timing.time)}`;
    case "weekly":
      return `每周${timing.weekdays.map((day) => weekdayNames[day - 1]).join("、")} ${clockIn(timing.time)}`;
    case "cron":
      return `cron ${timing.expression}`;
  }
}

type Draft = {
  sessionId: string;
  title: string;
  prompt: string;
  kind: AutomationTimingInput["kind"];
  /** `datetime-local` value for one-shot tasks. */
  at: string;
  minutes: number;
  time: string;
  weekdays: number[];
  expression: string;
};

/** DSH requires `HH:mm:ss`; the time input edits `HH:mm`. */
const clockOut = (time: string) => (time.length === 5 ? `${time}:00` : time);
const clockIn = (time: string) => time.slice(0, 5);

function localInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function emptyDraft(sessionId: string): Draft {
  return {
    sessionId,
    title: "",
    prompt: "",
    kind: "daily",
    at: localInput(new Date(Date.now() + 3_600_000)),
    minutes: 60,
    time: "09:00",
    weekdays: [1, 2, 3, 4, 5],
    expression: "0 9 * * 1-5",
  };
}

function draftOf(task: AutomationTask): Draft {
  const draft = { ...emptyDraft(task.sessionId), title: task.title };
  draft.prompt = task.prompt;
  const timing = task.timing;
  if (timing.kind === "at" || timing.kind === "after")
    return { ...draft, kind: "at", at: localInput(new Date(task.scheduledAt)) };
  if (timing.kind === "every")
    return { ...draft, kind: "every", minutes: timing.everySeconds / 60 };
  if (timing.kind === "daily")
    return { ...draft, kind: "daily", time: clockIn(timing.time) };
  if (timing.kind === "weekly")
    return {
      ...draft,
      kind: "weekly",
      time: clockIn(timing.time),
      weekdays: timing.weekdays,
    };
  return { ...draft, kind: "cron", expression: timing.expression };
}

function inputOf(draft: Draft): AutomationTaskInput {
  const timing: AutomationTimingInput =
    draft.kind === "at"
      ? { kind: "at", at: new Date(draft.at).toISOString() }
      : draft.kind === "every"
        ? { kind: "every", everySeconds: Math.round(draft.minutes * 60) }
        : draft.kind === "daily"
          ? { kind: "daily", time: clockOut(draft.time), timeZone: localZone }
          : draft.kind === "weekly"
            ? {
                kind: "weekly",
                time: clockOut(draft.time),
                timeZone: localZone,
                weekdays: [...draft.weekdays].sort(),
              }
            : {
                kind: "cron",
                expression: draft.expression.trim(),
                timeZone: localZone,
              };
  return {
    sessionId: draft.sessionId,
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    timing,
  };
}

/**
 * DSH-style automation page. Each task is a DSH Schedule reminder: when it is
 * due, DSH delivers its instruction into the chosen workspace conversation,
 * which runs it as a normal turn with the same tools.
 */
export function AutomationScreen({
  endpoint,
  conversations,
  openConversation,
}: {
  endpoint: string;
  conversations: CodingProjectsController;
  openConversation(projectId: string, sessionId: string): void;
}) {
  const [tasks, setTasks] = useState<AutomationTask[]>();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  /** `null` creates a task; a task edits that one. */
  const [editing, setEditing] = useState<AutomationTask | null>();

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setError("");
      try {
        const next = await listAutomation(endpoint, signal);
        if (!signal?.aborted) setTasks(next);
      } catch (cause) {
        if (!signal?.aborted) setError(problem(cause));
      }
    },
    [endpoint],
  );
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    // DSH advances `scheduledAt` after each delivery; poll while open.
    const timer = window.setInterval(() => void refresh(abort.signal), 30_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const choices = useMemo(
    () =>
      conversations.projects.flatMap((project) =>
        (conversations.conversations[project.id] ?? [])
          .filter((item) => item.archivedAt === undefined)
          .map((item) => ({
            id: item.id,
            label: `${project.title} / ${item.title}`,
          })),
      ),
    [conversations.projects, conversations.conversations],
  );

  const needle = query.trim().toLowerCase();
  const shown = (tasks ?? [])
    .filter((task) => filter === "all" || task.status === filter)
    .filter(
      (task) =>
        !needle ||
        `${task.title} ${task.prompt} ${task.conversationTitle ?? ""}`
          .toLowerCase()
          .includes(needle),
    )
    .sort(
      (a, b) =>
        (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) ||
        a.scheduledAt.localeCompare(b.scheduledAt),
    );
  const current = tasks?.find((task) => task.id === selected);

  return (
    <div className={`automation-layout${current ? " with-detail" : ""}`}>
      <section
        className="dsh-page automation-page"
        aria-labelledby="automation-title"
      >
        <header className="dsh-page-head">
          <div>
            <h1 id="automation-title">自动化任务</h1>
            <p>按时间在工作空间对话中自动执行指令，结果会出现在那段对话里。</p>
          </div>
          <div className="dsh-page-actions">
            <button
              type="button"
              className="dsh-icon-button"
              aria-label="刷新任务"
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="dsh-button primary"
              disabled={!choices.length}
              title={
                choices.length ? undefined : "请先在工作空间中开始一段对话"
              }
              onClick={() => setEditing(null)}
            >
              <Plus size={14} />
              新建任务
            </button>
          </div>
        </header>
        {error ? (
          <p className="dsh-page-notice" role="alert">
            {error}
          </p>
        ) : null}
        {tasks?.length ? (
          <div className="automation-filters">
            <div className="automation-pills" role="group" aria-label="筛选">
              {filters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="automation-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索任务"
                placeholder="搜索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {tasks && !tasks.length ? (
          <div className="automation-empty">
            <span className="automation-empty-art" aria-hidden="true">
              <AlarmClock size={28} />
            </span>
            <strong>还没有自动化任务</strong>
            <p>
              让 Aura 每天整理日报、定时检查构建，或在某个时间提醒你。
              {choices.length
                ? ""
                : "先在工作空间中开始一段对话，再为它添加任务。"}
            </p>
            {choices.length ? (
              <button
                type="button"
                className="dsh-button primary"
                onClick={() => setEditing(null)}
              >
                <Plus size={14} />
                新建任务
              </button>
            ) : null}
          </div>
        ) : null}
        {tasks?.length && !shown.length ? (
          <p className="dsh-page-empty">没有符合条件的任务</p>
        ) : null}
        <ul className="automation-list">
          {shown.map((task) => (
            <li key={`${task.sessionId}:${task.id}`}>
              <button
                type="button"
                className={`automation-row${task.id === selected ? " selected" : ""}`}
                aria-current={task.id === selected ? "true" : undefined}
                onClick={() =>
                  setSelected(task.id === selected ? undefined : task.id)
                }
              >
                <AlarmClock size={16} aria-hidden="true" />
                <span className="automation-row-text">
                  <strong>{task.title}</strong>
                  <span>
                    {task.status === "active" ? "运行中" : "已结束"} ·{" "}
                    {timingLabel(task.timing)}
                    {task.status === "active"
                      ? ` · 下次 ${new Date(task.scheduledAt).toLocaleString("zh-CN")}`
                      : ""}
                  </span>
                </span>
                <span className="automation-row-target">
                  {task.conversationTitle}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {current ? (
        <AutomationDetail
          key={`${current.sessionId}:${current.id}`}
          endpoint={endpoint}
          task={current}
          onClose={() => setSelected(undefined)}
          onEdit={() => setEditing(current)}
          onOpen={() =>
            current.projectId &&
            openConversation(current.projectId, current.sessionId)
          }
          onDeleted={() => {
            setSelected(undefined);
            void refresh();
          }}
        />
      ) : null}
      {editing !== undefined ? (
        <AutomationEditor
          endpoint={endpoint}
          task={editing}
          choices={choices}
          onClose={() => setEditing(undefined)}
          onSaved={(task) => {
            setEditing(undefined);
            setSelected(task.id);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function AutomationDetail({
  endpoint,
  task,
  onClose,
  onEdit,
  onOpen,
  onDeleted,
}: {
  endpoint: string;
  task: AutomationTask;
  onClose(): void;
  onEdit(): void;
  onOpen(): void;
  onDeleted(): void;
}) {
  const [history, setHistory] = useState<AutomationHistory>();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    automationHistory(endpoint, task.sessionId, task.id, abort.signal)
      .then(setHistory)
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(problem(cause));
      });
    return () => abort.abort();
  }, [endpoint, task.sessionId, task.id, task.lastDeliveredAt]);

  async function remove() {
    if (
      !window.confirm(
        `删除「${task.title}」？删除后不再运行，运行记录一并移除。`,
      )
    )
      return;
    setDeleting(true);
    try {
      await deleteAutomation(endpoint, task.sessionId, task.id);
      onDeleted();
    } catch (cause) {
      setError(problem(cause));
      setDeleting(false);
    }
  }

  return (
    <aside className="automation-detail" aria-label={`任务：${task.title}`}>
      <header>
        <h2>{task.title}</h2>
        <button
          type="button"
          className="dsh-icon-button"
          aria-label="关闭详情"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <dl>
        <dt>状态</dt>
        <dd>{task.status === "active" ? "运行中" : "已结束"}</dd>
        <dt>频率</dt>
        <dd>{timingLabel(task.timing)}</dd>
        {task.status === "active" ? (
          <>
            <dt>下次运行</dt>
            <dd>{new Date(task.scheduledAt).toLocaleString("zh-CN")}</dd>
          </>
        ) : null}
        <dt>对话</dt>
        <dd>
          <button type="button" className="automation-link" onClick={onOpen}>
            {task.conversationTitle}
          </button>
        </dd>
      </dl>
      <section>
        <h3>指令</h3>
        <p className="automation-prompt">{task.prompt}</p>
      </section>
      <div className="dsh-page-actions">
        {task.status === "active" ? (
          <button type="button" className="dsh-button" onClick={onEdit}>
            编辑
          </button>
        ) : null}
        <button
          type="button"
          className="dsh-button danger"
          disabled={deleting}
          onClick={() => void remove()}
        >
          删除
        </button>
      </div>
      <section>
        <h3>运行记录</h3>
        {error ? (
          <p className="dsh-page-notice" role="alert">
            {error}
          </p>
        ) : null}
        {history && !history.records.length ? (
          <p className="automation-muted">尚未运行</p>
        ) : null}
        <ol className="automation-history">
          {history?.records.map((record) => (
            <li key={record.deliveredAt}>
              <span>
                {new Date(record.deliveredAt).toLocaleString("zh-CN")}
              </span>
              <small>
                计划 {new Date(record.scheduledAt).toLocaleTimeString("zh-CN")}
              </small>
            </li>
          ))}
        </ol>
        {history?.truncated ? (
          <p className="automation-muted">更早的记录已按保留期限清理。</p>
        ) : null}
      </section>
    </aside>
  );
}

function AutomationEditor({
  endpoint,
  task,
  choices,
  onClose,
  onSaved,
}: {
  endpoint: string;
  task: AutomationTask | null;
  choices: Array<{ id: string; label: string }>;
  onClose(): void;
  onSaved(task: AutomationTask): void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    task ? draftOf(task) : emptyDraft(choices[0]?.id ?? ""),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (draft.kind === "weekly" && !draft.weekdays.length) {
      setError("请至少选择一天。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const input = inputOf(draft);
      onSaved(
        task
          ? await updateAutomation(endpoint, task.id, input)
          : await createAutomation(endpoint, input),
      );
    } catch (cause) {
      setError(problem(cause));
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="automation-dialog"
      aria-labelledby="automation-editor-title"
      onClose={onClose}
    >
      <form onSubmit={(event) => void save(event)}>
        <header>
          <h2 id="automation-editor-title">
            {task ? "编辑任务" : "新建自动化任务"}
          </h2>
          <button
            type="button"
            className="dsh-icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        <label>
          <span>名称</span>
          <input
            required
            maxLength={120}
            value={draft.title}
            placeholder="例如：每日构建检查"
            onChange={(event) => set({ title: event.target.value })}
          />
        </label>
        <label>
          <span>指令</span>
          <textarea
            required
            rows={4}
            value={draft.prompt}
            placeholder="到点时发送给 Aura 的消息"
            onChange={(event) => set({ prompt: event.target.value })}
          />
        </label>
        <label>
          <span>在哪段对话中运行</span>
          <select
            value={draft.sessionId}
            disabled={task !== null}
            onChange={(event) => set({ sessionId: event.target.value })}
          >
            {task && !choices.some((item) => item.id === task.sessionId) ? (
              <option value={task.sessionId}>{task.conversationTitle}</option>
            ) : null}
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>重复</legend>
          <div className="automation-pills">
            {(
              [
                ["at", "一次"],
                ["daily", "每天"],
                ["weekly", "每周"],
                ["every", "间隔"],
                ["cron", "Cron"],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                aria-pressed={draft.kind === kind}
                onClick={() => set({ kind })}
              >
                {label}
              </button>
            ))}
          </div>
          {draft.kind === "at" ? (
            <label>
              <span>时间</span>
              <input
                type="datetime-local"
                required
                value={draft.at}
                onChange={(event) => set({ at: event.target.value })}
              />
            </label>
          ) : null}
          {draft.kind === "daily" || draft.kind === "weekly" ? (
            <label>
              <span>时间（{localZone}）</span>
              <input
                type="time"
                required
                value={draft.time}
                onChange={(event) => set({ time: event.target.value })}
              />
            </label>
          ) : null}
          {draft.kind === "weekly" ? (
            <div className="automation-weekdays" role="group" aria-label="星期">
              {weekdayNames.map((name, index) => {
                const day = index + 1;
                const on = draft.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={`周${name}`}
                    onClick={() =>
                      set({
                        weekdays: on
                          ? draft.weekdays.filter((item) => item !== day)
                          : [...draft.weekdays, day],
                      })
                    }
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          ) : null}
          {draft.kind === "every" ? (
            <label>
              <span>每隔（分钟）</span>
              <input
                type="number"
                required
                min={1}
                step={1}
                value={draft.minutes}
                onChange={(event) =>
                  set({ minutes: Number(event.target.value) })
                }
              />
            </label>
          ) : null}
          {draft.kind === "cron" ? (
            <label>
              <span>Cron 表达式（{localZone}）</span>
              <input
                required
                value={draft.expression}
                spellCheck={false}
                onChange={(event) => set({ expression: event.target.value })}
              />
            </label>
          ) : null}
        </fieldset>
        {error ? (
          <p className="dsh-page-notice" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="dsh-page-actions">
          <button type="button" className="dsh-button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="dsh-button primary"
            disabled={saving || !draft.sessionId}
          >
            {task ? "保存" : "创建"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
