import React, { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  Clock3,
  FolderOpen,
  GitBranch,
  Grid2X2,
  ListFilter,
  LoaderCircle,
  MessageCircle,
  PanelLeftClose,
  Search,
  Settings2,
  SquarePen,
  X,
} from "lucide-react";
import { AuraMark } from "@aura/ui/components";
import type { WorkspaceController } from "./useWorkspace";
import type { Tab } from "./types";
import { groupSidebarSessions, sidebarSessionTitle } from "./sidebarSessions";

const tabs = [
  { id: "flows", label: "工作流", icon: GitBranch },
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "home", label: "概览", icon: Grid2X2 },
  { id: "history", label: "全部记录", icon: Clock3 },
] as const;

export function WorkspaceSidebar({
  workspace,
  tab,
  wide,
  onCollapse,
  navigate,
  start,
  open,
}: {
  workspace: WorkspaceController;
  tab: Tab;
  wide: boolean;
  onCollapse(): void;
  navigate(tab: Tab): void;
  start(): void;
  open(id: string): void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [closed, setClosed] = useState(new Set<string>());
  const search = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);
  const running = new Set(workspace.runningIds);
  const filtered = workspace.state.sessions.filter(
    (session) =>
      (!onlyRunning || running.has(session.id)) &&
      `${session.title} ${session.workflow?.title ?? ""} ${sidebarSessionTitle(session)} ${session.messages.at(-1)?.text ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const groups = groupSidebarSessions(filtered);
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
          新建会话
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
      <div className="session-heading">
        <span>会话</span>
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
                    const failed = session.messages.at(-1)?.status === "error";
                    const label = sidebarSessionTitle(session);
                    const selected =
                      workspace.active?.id === session.id && tab === "chat";
                    return (
                      <button
                        key={session.id}
                        className={`session-item${selected ? " selected" : ""}`}
                        aria-current={selected ? "true" : undefined}
                        aria-label={`打开会话：${label}`}
                        title={`${session.workflow?.title ?? session.title}\n${label}\n${new Date(session.updatedAt).toLocaleString("zh-CN")}${busy ? "\n运行中" : failed ? "\n运行失败" : ""}`}
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
                        {busy ? (
                          <LoaderCircle
                            size={14}
                            className="session-running"
                            aria-label="运行中"
                          />
                        ) : failed ? (
                          <CircleAlert
                            size={13}
                            className="session-failed"
                            aria-label="运行失败"
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
        {!groups.length ? (
          <div className="sidebar-empty">
            {query || onlyRunning ? "没有匹配的会话" : "从一段新会话开始"}
          </div>
        ) : null}
      </div>
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
