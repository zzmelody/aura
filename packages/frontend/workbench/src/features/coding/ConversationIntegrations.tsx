import React, { useEffect, useState } from "react";
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
}: {
  endpoint: string;
  projectId: string;
  open: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<{ query: string }>();
  const [result, setResult] = useState<{
    request: typeof submitted;
    items?: ConversationSearchHit[];
    error?: string;
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
            error: error instanceof Error ? error.message : "搜索未完成。",
          });
      });
    return () => abort.abort();
  }, [endpoint, projectId, submitted]);
  const current = result?.request === submitted ? result : undefined;

  return (
    <section className="conversation-integrations" aria-label="会话全文搜索">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) setSubmitted({ query: query.trim() });
        }}
      >
        <input
          aria-label="会话正文关键词"
          placeholder="搜索当前工作空间的会话正文"
          maxLength={256}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="dsh-button" disabled={!query.trim()}>
          搜索
        </button>
      </form>
      {submitted && !current ? <p role="status">正在搜索…</p> : null}
      {current?.error ? <p role="alert">{current.error}</p> : null}
      {current?.items?.length === 0 ? <p>没有匹配的会话。</p> : null}
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

const labels: Record<string, string> = {
  running: "运行中",
  inactive: "空闲",
  provisioning: "正在创建",
  failed: "失败",
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

export function AgentTeamPanel({
  endpoint,
  id,
}: {
  endpoint: string;
  id: string;
}) {
  const [team, setTeam] = useState<AgentTeamView>();
  const [error, setError] = useState("");
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
          setError(cause instanceof Error ? cause.message : "读取团队失败。");
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
    <section className="conversation-integrations" aria-label="Agent 团队">
      <p>在对话中让 Agent 创建具名队友并分配任务。</p>
      {error ? <p role="alert">{error}</p> : null}
      {team?.members.length ? (
        <ul aria-label="团队成员">
          {team.members.map(({ name, status }) => (
            <li key={name}>
              {name} · {labels[status] ?? status}
            </li>
          ))}
        </ul>
      ) : null}
      {team?.tasks.length ? (
        <ul aria-label="共享任务">
          {team.tasks.map(({ id: task, subject, status, owner }) => (
            <li key={task}>
              {subject} · {labels[status] ?? status}
              {owner ? ` · ${owner}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
