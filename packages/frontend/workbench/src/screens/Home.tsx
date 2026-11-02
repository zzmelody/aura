import React, { useState } from "react";
import { Archive, MessageCircle, Search, SquarePen } from "lucide-react";
import { FlowIcon } from "../FlowIcon";
import type { WorkspaceController } from "../useWorkspace";
import { sidebarSessionStatus, sidebarSessionTitle } from "../sidebarSessions";
import { SessionActions, type SessionDialogRequest } from "../SessionActions";
import { SessionStatus } from "../SessionStatus";
import type { CodingProjectsController } from "../features/coding/useCodingProjects";
import { PERSONAL_ASSISTANT_SESSION_ID } from "@aura/protocol/conversations";

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
    <section className="history-screen" aria-label="全部会话记录">
      <div className="history-heading">
        <div>
          <h1>全部记录</h1>
          <p>{remoteSessions.length + sessions.length} 段会话。</p>
        </div>
        <button className="tool-button" onClick={start}>
          <SquarePen size={15} />
          新对话
        </button>
      </div>
      <div className="history-controls">
        <div className="history-filters" aria-label="会话范围">
          {(
            [
              ["all", "全部"],
              ["active", "未归档"],
              ["archived", "已归档"],
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
            aria-label="搜索全部记录"
            placeholder="搜索会话…"
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
              aria-label={`打开会话：${item.title}`}
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
                  · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                </small>
              </span>
              <SessionStatus status={conversations.statuses[item.id]} text />
            </button>
            <button
              className="icon-control row-control"
              aria-label={`${item.archivedAt ? "取消归档" : "归档"}：${item.title}`}
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
                aria-label={`打开会话：${title}`}
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
                    {session.workflow?.title ?? "对话"} ·{" "}
                    {new Date(session.updatedAt).toLocaleDateString("zh-CN")}
                    {session.archivedAt ? (
                      <>
                        <Archive size={11} />
                        已归档
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
                ? "没有匹配的会话"
                : filter === "archived"
                  ? "归档的会话会出现在这里"
                  : "还没有会话记录"}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
