import React, { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Archive,
  ArchiveRestore,
  Clapperboard,
  Clock3,
  Code2,
  FolderOpen,
  GitBranch,
  ListFilter,
  MessageCircle,
  Newspaper,
  PanelLeftClose,
  PanelsTopLeft,
  Search,
  Settings2,
  SquarePen,
  Telescope,
  X,
} from "lucide-react";
import { AuraMark } from "@aura/ui/components";
import type { WorkspaceController } from "./useWorkspace";
import type { Tab } from "./types";
import {
  groupSidebarSessions,
  sidebarSessionTitle,
  sidebarSessionStatus,
  sidebarSessionTime,
} from "./sidebarSessions";
import { SessionStatus } from "./SessionStatus";
import { sessionMenuItems, type SessionDialogRequest } from "./SessionActions";
import { WorkbenchContextMenu } from "./WorkbenchContextMenu";
import { useToast } from "./toast";

const tabs = [
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "flows", label: "工作流", icon: GitBranch },
  { id: "history", label: "全部记录", icon: Clock3 },
  { id: "site", label: "Site", icon: PanelsTopLeft },
] as const;
/** Task studios sit beside chat and workflows; they are not workflow pages. */
const studios = [
  { id: "studio:content", label: "自媒体内容", icon: Newspaper },
  { id: "studio:video", label: "视频项目", icon: Clapperboard },
  { id: "studio:research", label: "选题库", icon: Telescope },
  { id: "studio:coding", label: "编码", icon: Code2 },
] as const;

export function WorkspaceSidebar({
  workspace,
  tab,
  wide,
  onCollapse,
  navigate,
  start,
  open,
  showArchived,
  onArchived,
  onDialog,
}: {
  workspace: WorkspaceController;
  tab: Tab;
  wide: boolean;
  onCollapse(): void;
  navigate(tab: Tab): void;
  start(): void;
  open(id: string): void;
  showArchived: boolean;
  onArchived(value: boolean): void;
  onDialog(request: SessionDialogRequest): void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [closed, setClosed] = useState(new Set<string>());
  const toast = useToast();
  /** Archive (or restore) and offer a one-click undo in a top toast. */
  function archiveWithUndo(
    session: { id: string; archivedAt?: number },
    label: string,
  ) {
    const archiving = !session.archivedAt;
    workspace.archiveChat(session.id, archiving);
    toast({
      message: archiving ? `已归档「${label}」` : `已恢复「${label}」`,
      action: {
        label: "撤销",
        run: () => workspace.archiveChat(session.id, !archiving),
      },
    });
  }
  // The "..." button is gone; actions live in a right-click menu per row.
  const [context, setContext] = useState<{
    sessionId: string;
    x: number;
    y: number;
  }>();
  const search = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);
  const running = new Set(workspace.runningIds);
  const filtered = workspace.state.sessions.filter(
    (session) =>
      Boolean(session.archivedAt) === showArchived &&
      (!onlyRunning || running.has(session.id)) &&
      `${session.title} ${session.workflow?.title ?? ""} ${sidebarSessionTitle(session)} ${session.messages.at(-1)?.text ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const groups = groupSidebarSessions(filtered);
  const now = Date.now();
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    searchButton.current?.focus();
  };
  return (
    <aside className="workspace-sidebar" aria-label="工作区与会话">
      <div className="sidebar-brand">
        <AuraMark size={22} />
        <strong>aura</strong>
        <div className="sidebar-brand-actions">
          <button
            ref={searchButton}
            className="icon-control"
            aria-label="搜索会话"
            title="搜索会话"
            aria-expanded={searchOpen}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            <Search size={17} />
          </button>
          <button
            className="icon-control"
            aria-label={wide ? "收起侧栏" : "关闭会话列表"}
            title={wide ? "收起侧栏" : "关闭会话列表"}
            onClick={onCollapse}
          >
            {wide ? <PanelLeftClose size={17} /> : <X size={17} />}
          </button>
        </div>
      </div>
      <nav className="workspace-nav" aria-label="主导航">
        <button className="new-session" onClick={start}>
          <SquarePen size={17} />
          新对话
        </button>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </nav>
      <nav className="workspace-nav studio-nav" aria-label="工作台">
        <span className="sidebar-group-label">工作台</span>
        {studios.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </nav>
      <div className="session-heading">
        <span>
          {showArchived ? "已归档" : "会话"} <small>{filtered.length}</small>
        </span>
        <div className="session-heading-actions">
          <button
            className="icon-control"
            aria-label={showArchived ? "返回会话列表" : "查看已归档会话"}
            title={showArchived ? "返回会话列表" : "查看已归档会话"}
            aria-pressed={showArchived}
            onClick={() => onArchived(!showArchived)}
          >
            <Archive size={15} />
          </button>
          <button
            className="icon-control"
            aria-label={onlyRunning ? "显示全部会话" : "仅显示进行中的会话"}
            title={onlyRunning ? "显示全部会话" : "仅显示进行中的会话"}
            aria-pressed={onlyRunning}
            onClick={() => setOnlyRunning(!onlyRunning)}
          >
            <ListFilter size={15} />
          </button>
        </div>
      </div>
      {searchOpen ? (
        <div className="session-search">
          <Search size={14} />
          <input
            ref={search}
            aria-label="搜索会话"
            placeholder="搜索会话…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeSearch();
              }
            }}
          />
          <button
            className="icon-control"
            aria-label="关闭会话搜索"
            onClick={closeSearch}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      <div className="session-list">
        {groups.map((group) => {
          const expanded = Boolean(
            query.trim() || onlyRunning || !closed.has(group.id),
          );
          return (
            <section
              className="session-folder"
              key={group.id}
              aria-label={group.title}
            >
              <button
                className="session-folder-heading"
                aria-label={`${expanded ? "收起" : "展开"}${group.workflow ? "工作流会话" : "会话分组"}：${group.title}`}
                aria-expanded={expanded}
                title={group.title}
                onClick={() =>
                  setClosed((value) => {
                    const next = new Set(value);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
              >
                {group.workflow ? (
                  <GitBranch size={16} />
                ) : (
                  <FolderOpen size={16} />
                )}
                <span>{group.title}</span>
                <ChevronDown size={13} className={expanded ? "" : "folded"} />
              </button>
              {expanded ? (
                <div className="session-folder-items">
                  {group.sessions.map((session) => {
                    const busy = running.has(session.id);
                    const status = sidebarSessionStatus(session, busy);
                    const label = sidebarSessionTitle(session);
                    const selected =
                      workspace.active?.id === session.id && tab === "chat";
                    return (
                      <div
                        className={`session-row${selected ? " selected" : ""}${context?.sessionId === session.id ? " menu-open" : ""}`}
                        key={session.id}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setContext({
                            sessionId: session.id,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                        onKeyDown={(event) => {
                          // Keyboard users reach the same menu with the context-menu key or Shift+F10.
                          if (
                            event.key !== "ContextMenu" &&
                            !(event.shiftKey && event.key === "F10")
                          )
                            return;
                          event.preventDefault();
                          const box =
                            event.currentTarget.getBoundingClientRect();
                          setContext({
                            sessionId: session.id,
                            x: box.right - 24,
                            y: box.bottom,
                          });
                        }}
                      >
                        <button
                          key={session.id}
                          className={`session-item${selected ? " selected" : ""}`}
                          aria-current={selected ? "true" : undefined}
                          aria-label={`打开会话：${label}`}
                          aria-description={`${new Date(session.updatedAt).toLocaleString("zh-CN")} · ${status.label}${session.archivedAt ? " · 已归档" : ""}`}
                          onClick={() => open(session.id)}
                        >
                          {session.workflow ? (
                            <GitBranch
                              size={12}
                              className="session-workflow-icon"
                              aria-label="工作流会话"
                            />
                          ) : null}
                          <span className="session-name">{label}</span>
                        </button>
                        {/* Metadata and archive share a reserved column, never the title. */}
                        <div className="session-row-tail">
                          <span className="session-row-meta">
                            <time
                              className="session-row-time"
                              dateTime={new Date(
                                session.updatedAt,
                              ).toISOString()}
                            >
                              {sidebarSessionTime(session.updatedAt, now)}
                            </time>
                            {status.kind !== "completed" &&
                            status.kind !== "idle" ? (
                              <SessionStatus status={status} />
                            ) : null}
                          </span>
                          <button
                            type="button"
                            className="icon-control session-archive"
                            aria-label={`${session.archivedAt ? "取消归档" : "归档"}：${label}`}
                            title={session.archivedAt ? "取消归档" : "归档"}
                            onClick={() => archiveWithUndo(session, label)}
                          >
                            {session.archivedAt ? (
                              <ArchiveRestore size={14} />
                            ) : (
                              <Archive size={14} />
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
        {!groups.length ? (
          <div className="sidebar-empty">
            {query || onlyRunning
              ? "没有匹配的会话"
              : showArchived
                ? "归档的会话会出现在这里"
                : "从一段新会话开始"}
          </div>
        ) : null}
      </div>
      {context
        ? (() => {
            const target = workspace.state.sessions.find(
              ({ id }) => id === context.sessionId,
            );
            return target ? (
              <WorkbenchContextMenu
                label={`会话操作：${sidebarSessionTitle(target)}`}
                items={sessionMenuItems(target, workspace, onDialog, () =>
                  archiveWithUndo(target, sidebarSessionTitle(target)),
                )}
                at={{ x: context.x, y: context.y }}
                onClose={() => setContext(undefined)}
              />
            ) : null;
          })()
        : null}
      <footer className="sidebar-footer">
        <button
          className={`sidebar-workspace${tab === "settings" ? " selected" : ""}`}
          onClick={() => navigate("settings")}
          aria-label="设置"
        >
          <span className="sidebar-avatar">
            <AuraMark size={18} />
          </span>
          <span>本地工作区</span>
          <Settings2 size={17} />
        </button>
      </footer>
    </aside>
  );
}
