import React, { useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  Archive,
  ArchiveRestore,
  Check,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  Search,
  SlidersHorizontal,
  SquarePen,
  X,
} from "lucide-react";
import { FlowIcon } from "./FlowIcon";
import { AuraAssistantIcon } from "./AuraAssistantIcon";
import { PERSONAL_ASSISTANT_SESSION_ID } from "@aura/protocol/conversations";
import type { WorkspaceController } from "./useWorkspace";
import type { Tab } from "./types";
import type { PluginStudio } from "./usePluginPages";
import { studioIcon } from "./studioIcons";
import { isPluginTab } from "./pluginPages";
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
import { WorkbenchMenu } from "./WorkbenchMenu";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { Tooltip } from "./Tooltip";
import { useToast } from "./toast";
import type { CodingProjectInfo } from "@aura/protocol/types";
import type { CodingProjectsController } from "./features/coding/useCodingProjects";
import { WorkspaceDialog } from "./features/coding/WorkspaceDialog";
import { isActiveStatus } from "./features/coding/conversationStatus";

/** Task-independent destinations; archives and the full log live in Settings. */
const tabs = [
  { id: "flows", label: "工作流", icon: FlowIcon },
  { id: "automation", label: "自动化任务", icon: AlarmClock },
  { id: "studios", label: "工作台", icon: LayoutGrid },
] as const;

export function WorkspaceSidebar({
  workspace,
  tab,
  dark,
  toggleTheme,
  onOpenArchived,
  onAssistant,
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
  openedStudios = [],
  closeStudio,
  scheduledIds,
}: {
  workspace: WorkspaceController;
  tab: Tab;
  dark: boolean;
  toggleTheme(): void;
  onOpenArchived(): void;
  onAssistant(): void;
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
  /** Studio tabs the user has opened; order here does not affect the list. */
  openedStudios?: readonly string[];
  /** Drops one studio from the sidebar shortcuts. */
  closeStudio(id: string): void;
  /** Conversations with an active automation task. */
  scheduledIds?: ReadonlySet<string>;
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
        item.id !== PERSONAL_ASSISTANT_SESSION_ID &&
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
  /**
   * Opened studios, in the order the plugins registered them. Which pages are
   * listed changes as they are opened and closed, but a listed page never
   * moves, so its row stays where the user last reached for it. The page in
   * view is always listed, so the sidebar never highlights nothing.
   */
  const opened = new Set([
    ...openedStudios,
    ...(isPluginTab(tab) ? [tab] : []),
  ]);
  const shortcuts = pluginStudios.filter((studio) => opened.has(studio.id));
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    searchButton.current?.focus();
  };
  return (
    <aside className="workspace-sidebar" aria-label="工作区与会话">
      <button className="new-session" onClick={start}>
        <SquarePen size={14} />
        新任务
      </button>
      <nav className="workspace-nav panel-nav" aria-label="主导航">
        <button
          className={`aura-assistant-entry${tab === "assistant" ? " selected" : ""}`}
          aria-label="打开 Aura 个人助手"
          aria-current={tab === "assistant" ? "page" : undefined}
          aria-busy={codingWorkspaces.assistantLoading}
          disabled={codingWorkspaces.assistantLoading}
          title="Aura · 持续使用同一段对话的个人助手"
          onClick={onAssistant}
        >
          <AuraAssistantIcon
            running={
              isActiveStatus(
                codingWorkspaces.statuses[PERSONAL_ASSISTANT_SESSION_ID],
              ) || codingWorkspaces.assistantLoading
            }
          />
          <span>Aura</span>
        </button>
        {tabs.map(({ id, label, icon: Icon }) => (
          <React.Fragment key={id}>
            <button
              className={tab === id ? "selected" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={16} />
              {label}
            </button>
            {/* The pages the user has opened, nested under 工作台 in
                registration order. Each closes on its own; 工作台 still
                lists every page. */}
            {id === "studios" && shortcuts.length ? (
              <div className="workspace-nav-children">
                {shortcuts.map((studio) => {
                  const Glyph = studioIcon(studio.page.definition.icon);
                  const selected = tab === studio.id;
                  return (
                    <div className="workspace-nav-child" key={studio.id}>
                      <button
                        className={selected ? "selected" : ""}
                        aria-current={selected ? "page" : undefined}
                        onClick={() => navigate(studio.id)}
                      >
                        <Glyph size={15} />
                        <span>{studio.title}</span>
                      </button>
                      <Tooltip label="从侧栏移除">
                        <button
                          type="button"
                          className="icon-control studio-close"
                          aria-label={`从侧栏移除：${studio.title}`}
                          onClick={() => closeStudio(studio.id)}
                        >
                          <X size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </React.Fragment>
        ))}
      </nav>
      {/* DSH section header: muted label, then search, view options and
          add-workspace. Search expands inline over the label and actions. */}
      <div
        className={`session-heading${searchOpen ? " searching" : ""}`}
        role="group"
        aria-label="会话列表工具"
      >
        <span className="session-heading-label">
          {showArchived ? "已归档" : onlyRunning ? "进行中" : "会话"}
        </span>
        {searchOpen ? (
          <label className="session-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={search}
              aria-label="搜索会话"
              placeholder="搜索会话名称"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => {
                if (!query.trim()) setSearchOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  closeSearch();
                }
              }}
            />
            {query ? (
              <Tooltip label="清除搜索">
                <button
                  type="button"
                  className="session-search-clear"
                  aria-label="清除搜索"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              </Tooltip>
            ) : null}
          </label>
        ) : (
          <div className="session-heading-actions">
            <Tooltip label="搜索">
              <button
                ref={searchButton}
                className="icon-control"
                aria-label="搜索会话"
                aria-expanded={false}
                onClick={() => setSearchOpen(true)}
              >
                <Search size={14} />
              </button>
            </Tooltip>
            <WorkbenchMenu
              label="视图选项"
              tooltip="视图选项"
              className={`icon-control${showArchived || onlyRunning ? " filtered" : ""}`}
              items={[
                {
                  id: "all",
                  label: "全部会话",
                  icon: (
                    <Check
                      size={14}
                      opacity={!showArchived && !onlyRunning ? 1 : 0}
                    />
                  ),
                  action: () => {
                    onArchived(false);
                    setOnlyRunning(false);
                  },
                },
                {
                  id: "running",
                  label: "仅显示进行中",
                  icon: <Check size={14} opacity={onlyRunning ? 1 : 0} />,
                  action: () => {
                    onArchived(false);
                    setOnlyRunning(true);
                  },
                },
                {
                  id: "archived",
                  label: "仅显示已归档",
                  icon: <Check size={14} opacity={showArchived ? 1 : 0} />,
                  action: () => {
                    setOnlyRunning(false);
                    onArchived(true);
                  },
                },
              ]}
            >
              <SlidersHorizontal size={14} />
            </WorkbenchMenu>
            <Tooltip label={offline ? "需要连接 Aura 服务" : "添加工作区"}>
              <button
                className="icon-control"
                aria-label="添加工作区"
                disabled={offline}
                onClick={() => setSpaceDialog(null)}
              >
                <FolderPlus size={16} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      {query.trim() &&
      !filtered.length &&
      !spaceFolders.some((folder) => folder.conversations.length) ? (
        <div className="sidebar-empty">无匹配会话</div>
      ) : null}
      <div className="session-list">
        {spaceFolders.map(({ space, conversations }) => {
          const key = `space:${space.id}`;
          const expanded = Boolean(query.trim() || !closed.has(key));
          // DSH paints the folder blue while it holds the open conversation.
          const current =
            (tab === "studio:coding" ||
              (tab === "chat" && !workspace.active)) &&
            conversations.some(
              (item) => item.id === codingWorkspaces.conversationId,
            );
          return (
            <section
              className="session-folder workspace-folder"
              key={key}
              aria-label={`工作空间：${space.title}`}
            >
              <div className="workspace-folder-head">
                <Tooltip
                  label={`${space.title}\n${space.directory}`}
                  side="right"
                >
                  <button
                    className={`session-folder-heading${current ? " current" : ""}`}
                    aria-label={`${expanded ? "收起" : "展开"}工作空间：${space.title}`}
                    aria-expanded={expanded}
                    onClick={() => toggleFolder(key)}
                  >
                    <span className="folder-glyph" aria-hidden="true">
                      {expanded ? (
                        <FolderOpen size={16} />
                      ) : (
                        <Folder size={16} />
                      )}
                      <ChevronRight size={12} className="folder-caret" />
                    </span>
                    <span>{space.title}</span>
                  </button>
                </Tooltip>
                <div className="workspace-folder-actions">
                  <WorkbenchMenu
                    label={`工作区“${space.title}”的操作`}
                    tooltip="更多操作"
                    className="icon-control"
                    items={[
                      {
                        id: "configure",
                        label: "配置名称与目录",
                        icon: <SlidersHorizontal size={14} />,
                        action: () => setSpaceDialog(space),
                      },
                    ]}
                  >
                    <Ellipsis size={14} />
                  </WorkbenchMenu>
                  <Tooltip label="新会话">
                    <button
                      type="button"
                      className="icon-control"
                      aria-label={`在“${space.title}”中新建会话`}
                      onClick={() => openSpace(space.id)}
                    >
                      <SquarePen size={14} />
                    </button>
                  </Tooltip>
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
                            {scheduledIds?.has(item.id) ? (
                              <AlarmClock
                                size={14}
                                className="session-schedule-mark"
                                aria-label="有自动化任务"
                              />
                            ) : null}
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
                          <Tooltip
                            label={
                              item.archivedAt !== undefined
                                ? "取消归档"
                                : "归档（同时关闭旁支）"
                            }
                          >
                            <button
                              type="button"
                              className="icon-control session-archive"
                              aria-label={`${item.archivedAt !== undefined ? "取消归档" : "归档"}：${item.title}`}
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
                          </Tooltip>
                        </div>
                      </div>
                    );
                  })}
                  {!conversations.length ? (
                    <div className="sidebar-empty workspace-folder-empty">
                      {codingWorkspaces.conversationErrors[space.id] ? (
                        <button
                          type="button"
                          className="text-control"
                          onClick={() =>
                            void codingWorkspaces
                              .refreshConversations(space.id, undefined, true)
                              .catch(() => {})
                          }
                        >
                          加载失败，点击重试
                        </button>
                      ) : codingWorkspaces.conversations[space.id] ===
                        undefined ? (
                        "正在加载对话…"
                      ) : (
                        "还没有对话"
                      )}
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
                          <Tooltip
                            label={session.archivedAt ? "取消归档" : "归档"}
                          >
                            <button
                              type="button"
                              className="icon-control session-archive"
                              aria-label={`${session.archivedAt ? "取消归档" : "归档"}：${label}`}
                              onClick={() => archiveWithUndo(session, label)}
                            >
                              {session.archivedAt ? (
                                <ArchiveRestore size={14} />
                              ) : (
                                <Archive size={14} />
                              )}
                            </button>
                          </Tooltip>
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
        <WorkspaceMenu
          workspace={workspace}
          dark={dark}
          settingsSelected={tab === "settings"}
          toggleTheme={toggleTheme}
          navigate={navigate}
          onArchived={onOpenArchived}
          onDialog={onDialog}
        />
      </footer>
    </aside>
  );
}
