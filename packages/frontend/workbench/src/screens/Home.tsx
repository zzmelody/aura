import React, { useState } from "react";
import { Archive, MessageCircle, Search, SquarePen } from "lucide-react";
import { FlowIcon } from "../FlowIcon";
import type { WorkspaceController } from "../useWorkspace";
import { sidebarSessionStatus, sidebarSessionTitle } from "../sidebarSessions";
import { SessionActions, type SessionDialogRequest } from "../SessionActions";
import { SessionStatus } from "../SessionStatus";
import type { CodingProjectsController } from "../features/coding/useCodingProjects";
import { PERSONAL_ASSISTANT_SESSION_ID } from "@aura/protocol/conversations";
import { formatDate } from "@aura/i18n/runtime";
import { useSidebarMessages } from "../sidebar-messages.ts";

export function HistoryScreen({
  workspace,
  open,
  start,
  onDialog,
  conversations,
  openConversation,
}: {
  workspace: WorkspaceController;
  open(id: string): void;
  start(): void;
  onDialog(request: SessionDialogRequest): void;
  conversations: CodingProjectsController;
  openConversation(projectId: string, sessionId: string): void;
}) {
  const { t } = useSidebarMessages();
  const [filter, setFilter] = useState<"all" | "active" | "archived">("all");
  const [query, setQuery] = useState("");
  const remote =
    workspace.state.provider === "offline"
      ? []
      : Object.values(conversations.conversations)
          .flat()
          .filter((item) => item.id !== PERSONAL_ASSISTANT_SESSION_ID);
  const remoteIds = new Set(remote.map((item) => item.id));
  const matches = (item: { title: string; archivedAt?: number }) =>
    (filter === "all" ||
      Boolean(item.archivedAt) === (filter === "archived")) &&
    item.title.toLowerCase().includes(query.trim().toLowerCase());
  const remoteSessions = remote
    .filter(matches)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const sessions = workspace.state.sessions.filter(
    (session) =>
      !remoteIds.has(`legacy-${session.id}`) &&
      (filter === "all" ||
        Boolean(session.archivedAt) === (filter === "archived")) &&
      `${sidebarSessionTitle(session)} ${session.workflow?.title ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="history-screen" aria-label={t("allHistory")}>
      <div className="history-heading">
        <div>
          <h1>{t("historyTitle")}</h1>
          <p>
            {t("historyCount", {
              count: remoteSessions.length + sessions.length,
            })}
          </p>
        </div>
        <button className="tool-button" onClick={start}>
          <SquarePen size={15} />
          {t("newChat")}
        </button>
      </div>
      <div className="history-controls">
        <div className="history-filters" aria-label={t("conversationScope")}>
          {(
            [
              ["all", t("all")],
              ["active", t("unarchived")],
              ["archived", t("archived")],
            ] as const
          ).map(([id, title]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {title}
            </button>
          ))}
        </div>
        <label className="history-search">
          <Search size={15} />
          <input
            aria-label={t("searchHistory")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="history-list">
        {remoteSessions.map((item) => (
          <div key={item.id} className="history-row" data-row-highlight>
            <button
              className="history-session row-control"
              aria-label={t("openChat", { title: item.title })}
              onClick={() => openConversation(item.projectId, item.id)}
            >
              <MessageCircle size={17} />
              <span className="history-session-name">
                <strong>{item.title}</strong>
                <small>
                  {
                    conversations.projects.find(
                      (project) => project.id === item.projectId,
                    )?.title
                  }{" "}
                  · {formatDate(item.updatedAt, { dateStyle: "medium" })}
                </small>
              </span>
              {conversations.statuses[item.id] ? (
                <SessionStatus status={conversations.statuses[item.id]} text />
              ) : null}
            </button>
            <button
              className="icon-control row-control"
              aria-label={t(item.archivedAt ? "restoreNamed" : "archiveNamed", {
                title: item.title,
              })}
              onClick={() =>
                void conversations
                  .archive(item.projectId, item.id, !item.archivedAt)
                  .catch(() => {})
              }
            >
              <Archive size={15} />
            </button>
          </div>
        ))}
        {sessions.map((session) => {
          const title = sidebarSessionTitle(session);
          return (
            <div key={session.id} className="history-row" data-row-highlight>
              <button
                className="history-session row-control"
                onClick={() => open(session.id)}
                aria-label={t("openChat", { title })}
              >
                <span className="history-session-icon">
                  {session.workflow ? (
                    <FlowIcon size={17} />
                  ) : (
                    <MessageCircle size={17} />
                  )}
                </span>
                <span className="history-session-name">
                  <strong>{title}</strong>
                  <small>
                    {session.workflow?.title ?? t("conversations")} ·{" "}
                    {formatDate(session.updatedAt, { dateStyle: "medium" })}
                    {session.archivedAt ? (
                      <>
                        <Archive size={11} />
                        {t("archived")}
                      </>
                    ) : null}
                  </small>
                </span>
                <SessionStatus
                  status={sidebarSessionStatus(
                    session,
                    workspace.runningIds.includes(session.id),
                  )}
                  text
                />
              </button>
              <SessionActions
                session={session}
                workspace={workspace}
                onDialog={onDialog}
                className="icon-control row-control"
              />
            </div>
          );
        })}
        {!sessions.length && !remoteSessions.length ? (
          <div className="history-empty">
            <Archive size={25} />
            <p>
              {query
                ? t("noMatches")
                : filter === "archived"
                  ? t("archiveEmpty")
                  : t("noHistory")}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
