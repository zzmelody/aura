import {
  useConversationMessages,
  conversationMessage,
  type ConversationMessageKey,
} from "../../conversation-messages.ts";
import {
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import React, { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type {
  AgentTeamView,
  ConversationSearchHit,
} from "@aura/protocol/types";
import { integrationRequest } from "../../integrations.tsx";
import "./conversation-integrations.css";

/** A match the search dialog opens: its conversation and the matching message. */
export type ConversationSearchTarget = {
  id: string;
  projectId?: string;
  seq?: number;
};

/**
 * Global conversation search in a centered dialog. Conversation names match
 * instantly from the loaded list; message text is searched after a short
 * pause, across every workspace.
 */
export function ConversationSearch({
  endpoint,
  titles = [],
  open,
  onClose,
}: {
  endpoint: string;
  /** Loaded conversations, matched by name before the text search returns. */
  titles?: ReadonlyArray<{
    id: string;
    projectId: string;
    title: string;
    place?: string;
  }>;
  open: (target: ConversationSearchTarget) => void;
  onClose(): void;
}) {
  const { t, i18n } = useConversationMessages();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<{ query: string }>();
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{
    request: typeof submitted;
    items?: ConversationSearchHit[];
    error?: string | MessageReference;
  }>();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal?.();
    input.current?.focus();
    return () => element?.close?.();
  }, []);
  // Text search follows typing after a pause; Enter runs it at once.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSubmitted(undefined);
      return;
    }
    const timer = setTimeout(() => setSubmitted({ query: trimmed }), 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!submitted) return;
    const abort = new AbortController();
    void integrationRequest<ConversationSearchHit[]>(
      endpoint,
      `/search?q=${encodeURIComponent(submitted.query)}`,
      { signal: abort.signal },
    )
      .then((items) => {
        if (!abort.signal.aborted) setResult({ request: submitted, items });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setResult({
            request: submitted,
            error: errorMessage(error, conversationMessage("searchFailed")),
          });
      });
    return () => abort.abort();
  }, [endpoint, submitted]);
  const current = result?.request === submitted ? result : undefined;
  const needle = query.trim().toLowerCase();
  const named = needle
    ? titles
        .filter((item) => item.title.toLowerCase().includes(needle))
        .slice(0, 8)
    : [];
  const places = new Map(titles.map((item) => [item.id, item.place]));
  const items: Array<{
    key: string;
    target: ConversationSearchTarget;
    title: string;
    detail?: string;
    place?: string;
  }> = [
    ...named.map((item) => ({
      key: `name:${item.id}`,
      target: { id: item.id, projectId: item.projectId },
      title: item.title,
      ...(item.place ? { place: item.place } : {}),
    })),
    ...(current?.items ?? []).map((item) => ({
      key: `text:${item.id}:${item.seq ?? ""}`,
      target: {
        id: item.id,
        ...(item.projectId ? { projectId: item.projectId } : {}),
        ...(item.seq === undefined ? {} : { seq: item.seq }),
      },
      title: item.title,
      detail: item.snippet,
      ...(places.get(item.id) ? { place: places.get(item.id) } : {}),
    })),
  ];
  const selected = Math.min(active, Math.max(0, items.length - 1));
  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    onClose();
    open(item.target);
  };
  const textCount = current?.items?.length ?? 0;
  return (
    <dialog
      ref={dialog}
      className="conversation-search-dialog"
      aria-label={t("searchTitle")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        role="search"
        className="conversation-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (items.length) choose(selected);
          else if (query.trim()) setSubmitted({ query: query.trim() });
        }}
      >
        <div className="conversation-search-field">
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls="conversation-search-results"
            aria-activedescendant={
              items.length ? `conversation-search-${selected}` : undefined
            }
            aria-label={t("searchKeywords")}
            placeholder={t("searchPlaceholder")}
            maxLength={256}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              if (!items.length) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((selected + step + items.length) % items.length);
            }}
          />
          {query ? (
            <button
              type="button"
              className="conversation-search-clear"
              aria-label={t("clearSearch")}
              onClick={() => {
                setQuery("");
                setSubmitted(undefined);
                input.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-control conversation-search-close"
          aria-label={t("closeSearch")}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </form>
      <div className="conversation-search-body">
        {submitted && !current ? <p role="status">{t("searching")}</p> : null}
        {current?.error ? (
          <p role="alert">{messageText(current.error, i18n)}</p>
        ) : null}
        {needle && current && !current.error && !items.length ? (
          <p>{t("noConversations")}</p>
        ) : null}
        {!needle ? <p>{t("searchHint")}</p> : null}
        <ul
          id="conversation-search-results"
          role="listbox"
          aria-label={t("searchTitle")}
        >
          {items.map((item, index) => (
            <React.Fragment key={item.key}>
              {index === 0 && named.length ? (
                <li role="presentation" className="conversation-search-group">
                  {t("searchNamesGroup")}
                </li>
              ) : null}
              {index === named.length && textCount ? (
                <li role="presentation" className="conversation-search-group">
                  {t("searchTextGroup")}
                </li>
              ) : null}
              <li
                id={`conversation-search-${index}`}
                role="option"
                aria-selected={index === selected}
                className="conversation-search-hit"
                onMouseMove={() => {
                  if (index !== selected) setActive(index);
                }}
                onClick={() => choose(index)}
              >
                <span className="conversation-search-hit-head">
                  <strong>{item.title}</strong>
                  {item.place ? <small>{item.place}</small> : null}
                </span>
                {item.detail ? <span>{item.detail}</span> : null}
              </li>
            </React.Fragment>
          ))}
        </ul>
      </div>
    </dialog>
  );
}

const labels: Record<string, ConversationMessageKey> = {
  running: "running",
  inactive: "idle",
  provisioning: "provisioning",
  failed: "failed",
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

export function AgentTeamPanel({
  endpoint,
  id,
}: {
  endpoint: string;
  id: string;
}) {
  const { t, i18n } = useConversationMessages();
  const [team, setTeam] = useState<AgentTeamView>();
  const [error, setError] = useState<string | MessageReference>("");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await integrationRequest<AgentTeamView>(
          endpoint,
          `/team/${encodeURIComponent(id)}`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setTeam(next);
        setError("");
      } catch (cause) {
        if (!abort.signal.aborted)
          setError(errorMessage(cause, conversationMessage("teamFailed")));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void read(), 3000);
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, id]);
  return (
    <section className="conversation-integrations" aria-label={t("team")}>
      <p>{t("teamHint")}</p>
      {error ? <p role="alert">{messageText(error, i18n)}</p> : null}
      {team?.members.length ? (
        <ul aria-label={t("members")}>
          {team.members.map(({ name, status }) => (
            <li key={name}>
              {name} · {labels[status] ? t(labels[status]) : status}
            </li>
          ))}
        </ul>
      ) : null}
      {team?.tasks.length ? (
        <ul aria-label={t("sharedTasks")}>
          {team.tasks.map(({ id: task, subject, status, owner }) => (
            <li key={task}>
              {subject} · {labels[status] ? t(labels[status]) : status}
              {owner ? ` · ${owner}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
