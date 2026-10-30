import React, { useEffect, useRef, useState } from "react";
import {
  ChartCandlestick,
  ChevronDown,
  Clapperboard,
  Newspaper,
  Telescope,
  PanelsTopLeft,
  Archive,
  ArchiveRestore,
  Clock3,
  FolderOpen,
  FolderPlus,
  Layers,
  ListFilter,
  MessageCircle,
  PanelLeftClose,
  Search,
  Settings2,
  SlidersHorizontal,
  SquarePen,
  Puzzle,
  X,
} from "lucide-react";
import { FlowIcon } from "./FlowIcon";
import { AuraMark } from "@aura/ui/components";
import type { WorkspaceController } from "./useWorkspace";
import type { Tab } from "./types";
import type { PluginStudio } from "./usePluginPages";
import {
  groupSidebarSessions,
  sidebarSessionTitle,
  sidebarRowStatus,
  sidebarSessionStatus,
  sidebarSessionTime,
} from "./sidebarSessions";
import { SessionStatus } from "./SessionStatus";
import { sessionMenuItems, type SessionDialogRequest } from "./SessionActions";
import { WorkbenchContextMenu } from "./WorkbenchContextMenu";
import { useToast } from "./toast";
import type { CodingProjectInfo } from "@aura/protocol/types";
import type { CodingProjectsController } from "./features/coding/useCodingProjects";
import { WorkspaceDialog } from "./features/coding/WorkspaceDialog";
import { isActiveStatus } from "./features/coding/conversationStatus";

const tabs = [
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "flows", label: "工作流", icon: FlowIcon },
  { id: "history", label: "全部记录", icon: Clock3 },
] as const;
const studioIcons: Record<string, typeof Puzzle> = {
  ChartCandlestick,
  Clapperboard,
  Newspaper,
  Telescope,
  PanelsTopLeft,
  MessageCircle,
};

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
  endpoint,
  codingWorkspaces,
  offline,
  pluginStudios = [],
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
  endpoint: string;
  codingWorkspaces: CodingProjectsController;
  offline: boolean;
  pluginStudios?: readonly PluginStudio[];
}) {
  /** `null` creates a workspace; a record configures that one. */
  const [spaceDialog, setSpaceDialog] = useState<CodingProjectInfo | null>();
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
    projectId?: string;
    x: number;
    y: number;
  }>();
  const search = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);
  const running = new Set(workspace.runningIds);
  const remoteIds = new Set(
    Object.values(codingWorkspaces.conversations)
      .flat()
      .map((item) => item.id),
  );
  const filtered = workspace.state.sessions.filter(
    (session) =>
      (offline || !remoteIds.has(`legacy-${session.id}`)) &&
      Boolean(session.archivedAt) === showArchived &&
      (!onlyRunning || running.has(session.id)) &&
      `${session.title} ${session.workflow?.title ?? ""} ${sidebarSessionTitle(session)} ${session.messages.at(-1)?.text ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const groups = groupSidebarSessions(filtered);
  // Workspace folders use the same archive view as ordinary conversations.
  const needle = query.trim().toLowerCase();
  const spaceFolders = codingWorkspaces.projects.flatMap((space) => {
    const all = (codingWorkspaces.conversations[space.id] ?? []).filter(
      (item) =>
        (item.archivedAt !== undefined) === showArchived &&
        (!onlyRunning || isActiveStatus(codingWorkspaces.statuses[item.id])),
    );
    if ((showArchived || onlyRunning) && !all.length) return [];
    if (!needle || space.title.toLowerCase().includes(needle))
      return [{ space, conversations: all }];
    const matched = all.filter((item) =>
      item.title.toLowerCase().includes(needle),
    );
    return matched.length ? [{ space, conversations: matched }] : [];
  });
  const toggleFolder = (key: string) =>
    setClosed((value) => {
      const next = new Set(value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const openSpace = (projectId: string, conversationId?: string) => {
    workspace.newChat();
    codingWorkspaces.open(projectId, conversationId);
    navigate("studio:coding");
  };
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
        {pluginStudios.map(({ id, title, icon }) => {
          const Icon = studioIcons[icon ?? ""] ?? Puzzle;
          return (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={17} />
              {title}
            </button>
          );
        })}
      </nav>
      <div className="session-heading">
        <span>
          {showArchived ? "已归档" : "会话"}{" "}
          <small>
            {filtered.length +
              spaceFolders.reduce(
                (sum, folder) => sum + folder.conversations.length,
                0,
              )}
          </small>
        </span>
        <div className="session-heading-actions">
          <button
            className="icon-control"
            aria-label="新建工作空间"
            title={offline ? "需要连接 Aura 服务" : "新建工作空间"}
            disabled={offline}
            onClick={() => setSpaceDialog(null)}
          >
            <FolderPlus size={15} />
          </button>
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
        {spaceFolders.map(({ space, conversations }) => {
          const key = `space:${space.id}`;
          const expanded = Boolean(query.trim() || !closed.has(key));
          return (
            <section
              className="session-folder workspace-folder"
              key={key}
              aria-label={`工作空间：${space.title}`}
            >
              <div className="workspace-folder-head">
                <button
                  className="session-folder-heading"
                  aria-label={`${expanded ? "收起" : "展开"}工作空间：${space.title}`}
                  aria-expanded={expanded}
                  title={space.directory}
                  onClick={() => toggleFolder(key)}
                >
                  <Layers size={16} />
                  <span>{space.title}</span>
                  <ChevronDown size={13} className={expanded ? "" : "folded"} />
                </button>
                <div className="workspace-folder-actions">
                  <button
                    type="button"
                    className="icon-control"
                    aria-label={`在「${space.title}」中新建对话`}
                    title="新建对话"
                    onClick={() => openSpace(space.id)}
                  >
                    <SquarePen size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-control"
                    aria-label={`配置工作空间：${space.title}`}
                    title="配置名称与目录"
                    onClick={() => setSpaceDialog(space)}
                  >
                    <SlidersHorizontal size={14} />
                  </button>
                </div>
              </div>
              {expanded ? (
                <div className="session-folder-items">
                  {conversations.map((item) => {
                    const selected =
                      (tab === "studio:coding" ||
                        (tab === "chat" && !workspace.active)) &&
                      codingWorkspaces.conversationId === item.id;
                    const status = codingWorkspaces.statuses[item.id];
                    const badge = sidebarRowStatus(status);
                    return (
                      <div
                        className={`session-row${selected ? " selected" : ""}`}
                        key={item.id}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setContext({
                            sessionId: item.id,
                            projectId: space.id,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                      >
                        <button
                          className={`session-item${selected ? " selected" : ""}`}
                          aria-current={selected ? "true" : undefined}
                          aria-label={`打开工作空间对话：${item.title}`}
                          aria-description={`${new Date(item.updatedAt).toLocaleString("zh-CN")}${status ? ` · ${status.label}` : ""}${item.archivedAt !== undefined ? " · 已归档" : ""}`}
                          onClick={() => openSpace(space.id, item.id)}
                        >
                          <span className="session-name">{item.title}</span>
                        </button>
                        <div className="session-row-tail">
                          <span className="session-row-meta">
                            {badge ? (
                              <SessionStatus status={badge} />
                            ) : (
                              <time
                                className="session-row-time"
                                dateTime={new Date(
                                  item.updatedAt,
                                ).toISOString()}
                              >
                                {sidebarSessionTime(item.updatedAt, now)}
                              </time>
                            )}
                          </span>
                          <button
                            type="button"
                            className="icon-control session-archive"
                            aria-label={`${item.archivedAt !== undefined ? "取消归档" : "归档"}：${item.title}`}
                            title={
                              item.archivedAt !== undefined
                                ? "取消归档"
                                : "归档（同时关闭旁支）"
                            }
                            onClick={() =>
                              void codingWorkspaces
                                .archive(
                                  space.id,
                                  item.id,
                                  item.archivedAt === undefined,
                                )
                                .catch((reason: unknown) =>
                                  toast({
                                    message:
                                      reason instanceof Error
                                        ? reason.message
                                        : String(reason),
                                  }),
                                )
                            }
                          >
                            {item.archivedAt !== undefined ? (
                              <ArchiveRestore size={14} />
                            ) : (
                              <Archive size={14} />
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {!conversations.length ? (
                    <div className="sidebar-empty workspace-folder-empty">
                      还没有对话
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
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
                onClick={() => toggleFolder(group.id)}
              >
                {group.workflow ? (
                  <FlowIcon size={16} />
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
                    const badge = sidebarRowStatus(status);
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
                            <FlowIcon
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
                            {badge ? (
                              <SessionStatus status={badge} />
                            ) : (
                              <time
                                className="session-row-time"
                                dateTime={new Date(
                                  session.updatedAt,
                                ).toISOString()}
                              >
                                {sidebarSessionTime(session.updatedAt, now)}
                              </time>
                            )}
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
        {!groups.length && !spaceFolders.length ? (
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
            if (context.projectId) {
              const projectId = context.projectId;
              const target = codingWorkspaces.conversations[projectId]?.find(
                (item) => item.id === context.sessionId,
              );
              const failed = (reason: unknown) =>
                toast({
                  message:
                    reason instanceof Error ? reason.message : String(reason),
                });
              return target ? (
                <WorkbenchContextMenu
                  label={`会话操作：${target.title}`}
                  items={[
                    {
                      id: "archive",
                      label:
                        target.archivedAt !== undefined
                          ? "取消归档"
                          : "归档会话",
                      icon:
                        target.archivedAt !== undefined ? (
                          <ArchiveRestore size={15} />
                        ) : (
                          <Archive size={15} />
                        ),
                      action: () =>
                        void codingWorkspaces
                          .archive(
                            projectId,
                            target.id,
                            target.archivedAt === undefined,
                          )
                          .catch(failed),
                    },
                    {
                      id: "close",
                      label: "关闭会话及旁支",
                      icon: <X size={15} />,
                      action: () =>
                        void codingWorkspaces
                          .close(projectId, target.id)
                          .catch(failed),
                    },
                  ]}
                  at={{ x: context.x, y: context.y }}
                  onClose={() => setContext(undefined)}
                />
              ) : null;
            }
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
      {spaceDialog !== undefined ? (
        <WorkspaceDialog
          endpoint={endpoint}
          workspace={spaceDialog ?? undefined}
          onSaved={(saved) => {
            void codingWorkspaces
              .refresh()
              .then(() => openSpace(saved.id))
              .catch(() => {});
          }}
          onClose={() => setSpaceDialog(undefined)}
        />
      ) : null}
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
