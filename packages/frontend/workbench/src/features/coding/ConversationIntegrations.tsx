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

export function ConversationSearch({
  endpoint,
  projectId,
  open,
  onClose,
}: {
  endpoint: string;
  projectId: string;
  open: (id: string) => void;
  onClose?(): void;
}) {
  const { t, i18n } = useConversationMessages();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<{ query: string }>();
  const [result, setResult] = useState<{
    request: typeof submitted;
    items?: ConversationSearchHit[];
    error?: string | MessageReference;
  }>();

  useEffect(() => {
    if (!submitted) return;
    const abort = new AbortController();
    void integrationRequest<ConversationSearchHit[]>(
      endpoint,
      `/search?project=${encodeURIComponent(projectId)}&q=${encodeURIComponent(submitted.query)}`,
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
  }, [endpoint, projectId, submitted]);
  const current = result?.request === submitted ? result : undefined;

  return (
    <section
      className="conversation-integrations conversation-search"
      aria-label={t("searchTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onClose) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <form
        role="search"
        className="conversation-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) setSubmitted({ query: query.trim() });
        }}
      >
        <div className="conversation-search-field">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            aria-label={t("searchKeywords")}
            placeholder={t("searchPlaceholder")}
            maxLength={256}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
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
          type="submit"
          className="conversation-search-submit"
          disabled={!query.trim()}
        >
          {t("search")}
        </button>
        {onClose ? (
          <button
            type="button"
            className="icon-control conversation-search-close"
            aria-label={t("closeSearch")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        ) : null}
      </form>
      {submitted && !current ? <p role="status">{t("searching")}</p> : null}
      {current?.error ? (
        <p role="alert">{messageText(current.error, i18n)}</p>
      ) : null}
      {current?.items?.length === 0 ? <p>{t("noConversations")}</p> : null}
      <ul>
        {current?.items?.map(({ id, title, snippet }) => (
          <li key={id}>
            <button
              type="button"
              className="conversation-search-hit"
              onClick={() => open(id)}
            >
              <strong>{title}</strong>
              <span>{snippet}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
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
