import {
  errorMessage,
  formatDate,
  formatNumber,
  formatRelativeTime,
  language,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  automationMessage,
  useAutomationMessages,
  type AutomationMessageKey,
} from "./automation-messages.ts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
const filters: Array<{ id: Filter; label: AutomationMessageKey }> = [
  { id: "all", label: "all" },
  { id: "active", label: "active" },
  { id: "ended", label: "ended" },
];
function weekdayName(day: number, locale: string, width: "short" | "long") {
  return new Intl.DateTimeFormat(locale, {
    weekday: width,
    timeZone: "UTC",
  }).format(Date.UTC(2026, 0, 4 + day));
}
const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

function problem(cause: unknown): string | MessageReference {
  return errorMessage(cause, automationMessage("unavailable"));
}

/** Schedule labels are display-only; stored timing and zone are unchanged. */
export function timingLabel(
  timing: AutomationTiming,
  locale = language.getSnapshot().locale,
): string {
  const t = language.i18n.getFixedT(locale, "automation");
  const clock = (value: string) =>
    formatDate(
      new Date("2000-01-01T" + clockOut(value) + "Z"),
      { timeStyle: "short", timeZone: "UTC" },
      locale,
    );
  switch (timing.kind) {
    case "at":
      return t("onceAt", {
        date: formatDate(
          timing.at,
          { dateStyle: "short", timeStyle: "short" },
          locale,
        ),
      });
    case "after":
      return t("onceAfter", {
        relative: formatRelativeTime(
          Math.round(timing.afterSeconds / 60),
          "minute",
          locale,
          { numeric: "always" },
        ),
      });
    case "every": {
      const hours = timing.everySeconds % 3600 === 0;
      return t("interval", {
        duration: formatNumber(
          hours
            ? timing.everySeconds / 3600
            : Math.round(timing.everySeconds / 60),
          {
            style: "unit",
            unit: hours ? "hour" : "minute",
            unitDisplay: "long",
          },
          locale,
        ),
      });
    }
    case "daily":
      return t("dailyAt", { time: clock(timing.time) });
    case "weekly":
      return t("weeklyAt", {
        days: new Intl.ListFormat(locale).format(
          timing.weekdays.map((day) => weekdayName(day, locale, "short")),
        ),
        time: clock(timing.time),
      });
    case "cron":
      return t("cronValue", { expression: timing.expression });
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
  const { t, i18n } = useAutomationMessages();
  const [error, setError] = useState<string | MessageReference>("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{ id: string; open: boolean }>();
  const detailTrigger = useRef<HTMLButtonElement>(null);
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
  const current = tasks?.find((task) => task.id === selection?.id);
  const detailOpen = !!current && selection?.open === true;
  const closeDetail = (id: string) =>
    setSelection((value) => (value?.id === id ? { id, open: false } : value));
  useEffect(() => {
    if (!detailOpen) detailTrigger.current?.focus({ preventScroll: true });
  }, [detailOpen]);

  return (
    <div className={`automation-layout${detailOpen ? " with-detail" : ""}`}>
      <section
        className="dsh-page automation-page"
        aria-labelledby="automation-title"
      >
        <header className="dsh-page-head">
          <div>
            <h1 id="automation-title">{t("title")}</h1>
            <p>{t("description")}</p>
          </div>
          <div className="dsh-page-actions">
            <button
              type="button"
              className="dsh-icon-button"
              aria-label={t("refresh")}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="dsh-button primary"
              disabled={!choices.length}
              title={choices.length ? undefined : t("startConversation")}
              onClick={() => setEditing(null)}
            >
              <Plus size={14} />
              {t("newTask")}
            </button>
          </div>
        </header>
        {error ? (
          <p className="dsh-page-notice" role="alert">
            {messageText(error, i18n)}
          </p>
        ) : null}
        {tasks?.length ? (
          <div className="automation-filters">
            <div
              className="automation-pills"
              role="group"
              aria-label={t("filter")}
            >
              {filters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
            <label className="automation-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label={t("searchTasks")}
                placeholder={t("search")}
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
            <strong>{t("empty")}</strong>
            <p>
              {t("emptyHint")}
              {choices.length ? "" : t("emptyStart")}
            </p>
            {choices.length ? (
              <button
                type="button"
                className="dsh-button primary"
                onClick={() => setEditing(null)}
              >
                <Plus size={14} />
                {t("newTask")}
              </button>
            ) : null}
          </div>
        ) : null}
        {tasks?.length && !shown.length ? (
          <p className="dsh-page-empty">{t("noMatch")}</p>
        ) : null}
        <ul className="automation-list">
          {shown.map((task) => {
            const selected = detailOpen && task.id === current?.id;
            return (
              <li key={`${task.sessionId}:${task.id}`}>
                <button
                  type="button"
                  className={`automation-row${selected ? " selected" : ""}`}
                  aria-current={selected ? "true" : undefined}
                  onClick={(event) => {
                    detailTrigger.current = event.currentTarget;
                    if (selected) closeDetail(task.id);
                    else setSelection({ id: task.id, open: true });
                  }}
                >
                  <AlarmClock size={16} aria-hidden="true" />
                  <span className="automation-row-text">
                    <strong>{task.title}</strong>
                    <span>
                      {task.status === "active" ? t("active") : t("ended")} ·{" "}
                      {timingLabel(task.timing)}
                      {task.status === "active"
                        ? ` · ${t("nextAt", { date: formatDate(task.scheduledAt, { dateStyle: "short", timeStyle: "short" }) })}`
                        : ""}
                    </span>
                  </span>
                  <span className="automation-row-target">
                    {task.conversationTitle}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {current ? (
        <AutomationDetail
          key={`${current.sessionId}:${current.id}`}
          endpoint={endpoint}
          task={current}
          open={detailOpen}
          onClose={() => closeDetail(current.id)}
          onEdit={() => setEditing(current)}
          onOpen={() =>
            current.projectId &&
            openConversation(current.projectId, current.sessionId)
          }
          onDeleted={() => {
            closeDetail(current.id);
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
            setSelection({ id: task.id, open: true });
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
  open,
  onClose,
  onEdit,
  onOpen,
  onDeleted,
}: {
  endpoint: string;
  task: AutomationTask;
  open: boolean;
  onClose(): void;
  onEdit(): void;
  onOpen(): void;
  onDeleted(): void;
}) {
  const [history, setHistory] = useState<AutomationHistory>();
  const { t, i18n } = useAutomationMessages();
  const [error, setError] = useState<string | MessageReference>("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    automationHistory(endpoint, task.sessionId, task.id, abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        setHistory(next);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(problem(cause));
      });
    return () => abort.abort();
  }, [open, endpoint, task.sessionId, task.id, task.lastDeliveredAt]);

  async function remove() {
    if (!window.confirm(t("confirmDelete", { title: task.title }))) return;
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
    <aside
      className="automation-detail"
      aria-label={t("taskLabel", { title: task.title })}
      inert={!open}
    >
      <header>
        <h2>{task.title}</h2>
        <button
          type="button"
          className="dsh-icon-button"
          aria-label={t("closeDetails")}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <dl>
        <dt>{t("status")}</dt>
        <dd>{task.status === "active" ? t("active") : t("ended")}</dd>
        <dt>{t("frequency")}</dt>
        <dd>{timingLabel(task.timing)}</dd>
        {task.status === "active" ? (
          <>
            <dt>{t("nextRun")}</dt>
            <dd>
              {formatDate(task.scheduledAt, {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </dd>
          </>
        ) : null}
        <dt>{t("conversation")}</dt>
        <dd>
          <button type="button" className="automation-link" onClick={onOpen}>
            {task.conversationTitle}
          </button>
        </dd>
      </dl>
      <section>
        <h3>{t("prompt")}</h3>
        <p className="automation-prompt">{task.prompt}</p>
      </section>
      <div className="dsh-page-actions">
        {task.status === "active" ? (
          <button type="button" className="dsh-button" onClick={onEdit}>
            {t("edit")}
          </button>
        ) : null}
        <button
          type="button"
          className="dsh-button danger"
          disabled={deleting}
          onClick={() => void remove()}
        >
          {t("delete")}
        </button>
      </div>
      <section>
        <h3>{t("history")}</h3>
        {error ? (
          <p className="dsh-page-notice" role="alert">
            {messageText(error, i18n)}
          </p>
        ) : null}
        {history && !history.records.length ? (
          <p className="automation-muted">{t("notRun")}</p>
        ) : null}
        <ol className="automation-history">
          {history?.records.map((record) => (
            <li key={record.deliveredAt}>
              <span>
                {formatDate(record.deliveredAt, {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
              <small>
                {t("scheduledAt", {
                  time: formatDate(record.scheduledAt, { timeStyle: "short" }),
                })}
              </small>
            </li>
          ))}
        </ol>
        {history?.truncated ? (
          <p className="automation-muted">{t("historyPruned")}</p>
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
  const { t, i18n } = useAutomationMessages();
  const [error, setError] = useState<string | MessageReference>("");
  const dialog = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (draft.kind === "weekly" && !draft.weekdays.length) {
      setError(automationMessage("chooseDay"));
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
            {task ? t("editTask") : t("createTitle")}
          </h2>
          <button
            type="button"
            className="dsh-icon-button"
            aria-label={t("close")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        <label>
          <span>{t("name")}</span>
          <input
            required
            maxLength={120}
            value={draft.title}
            placeholder={t("namePlaceholder")}
            onChange={(event) => set({ title: event.target.value })}
          />
        </label>
        <label>
          <span>{t("prompt")}</span>
          <textarea
            required
            rows={4}
            value={draft.prompt}
            placeholder={t("promptPlaceholder")}
            onChange={(event) => set({ prompt: event.target.value })}
          />
        </label>
        <label>
          <span>{t("target")}</span>
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
          <legend>{t("repeat")}</legend>
          <div className="automation-pills">
            {(
              [
                ["at", t("once")],
                ["daily", t("daily")],
                ["weekly", t("weekly")],
                ["every", t("every")],
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
              <span>{t("time")}</span>
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
              <span>{t("timeZone", { zone: localZone })}</span>
              <input
                type="time"
                required
                value={draft.time}
                onChange={(event) => set({ time: event.target.value })}
              />
            </label>
          ) : null}
          {draft.kind === "weekly" ? (
            <div
              className="automation-weekdays"
              role="group"
              aria-label={t("weekdays")}
            >
              {Array.from({ length: 7 }, (_, index) => {
                const day = index + 1;
                const on = draft.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={weekdayName(
                      day,
                      i18n.resolvedLanguage ?? "en",
                      "long",
                    )}
                    onClick={() =>
                      set({
                        weekdays: on
                          ? draft.weekdays.filter((item) => item !== day)
                          : [...draft.weekdays, day],
                      })
                    }
                  >
                    {weekdayName(day, i18n.resolvedLanguage ?? "en", "short")}
                  </button>
                );
              })}
            </div>
          ) : null}
          {draft.kind === "every" ? (
            <label>
              <span>{t("minutes")}</span>
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
              <span>{t("cronZone", { zone: localZone })}</span>
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
            {messageText(error, i18n)}
          </p>
        ) : null}
        <footer className="dsh-page-actions">
          <button type="button" className="dsh-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="dsh-button primary"
            disabled={saving || !draft.sessionId}
          >
            {task ? t("save") : t("create")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
