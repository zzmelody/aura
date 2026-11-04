import React from "react";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Square,
  Trash2,
} from "lucide-react";
import type { Session } from "@aura/core/types";
import type { WorkspaceController } from "./useWorkspace";
import { WorkbenchMenu, type WorkbenchMenuItem } from "./WorkbenchMenu";
import { sidebarSessionTitle } from "./sidebarSessions";

export type SessionDialogRequest = {
  sessionId: string;
  mode: "rename" | "delete";
};

/** The session actions, shared by the "..." menu and the sidebar right-click menu. */
export function sessionMenuItems(
  session: Session,
  workspace: WorkspaceController,
  onDialog: (request: SessionDialogRequest) => void,
  onArchive?: () => void,
): WorkbenchMenuItem[] {
  const busy = workspace.runningIds.includes(session.id);
  const blocked =
    busy ||
    workspace.workflows.hasOpenRun(session.id) ||
    Boolean(session.workflow?.pending || session.pendingWorkflow);
  return [
    {
      id: "rename",
      label: "重命名",
      icon: <Pencil size={15} />,
      action: () => onDialog({ sessionId: session.id, mode: "rename" }),
    },
    {
      id: "archive",
      label: session.archivedAt ? "取消归档" : "归档会话",
      icon: session.archivedAt ? (
        <ArchiveRestore size={15} />
      ) : (
        <Archive size={15} />
      ),
      action:
        onArchive ??
        (() => workspace.archiveChat(session.id, !session.archivedAt)),
    },
    ...(busy
      ? [
          {
            id: "stop",
            label: "停止执行",
            icon: <Square size={15} />,
            action: () => workspace.stopSession(session.id),
          },
        ]
      : []),
    { id: "divider", separator: true },
    {
      id: "delete",
      label: blocked ? "执行结束后可删除" : "删除会话",
      icon: <Trash2 size={15} />,
      danger: true,
      disabled: blocked,
      action: () => onDialog({ sessionId: session.id, mode: "delete" }),
    },
  ];
}

export function SessionActions({
  session,
  workspace,
  onDialog,
  className,
  leadingItems = [],
}: {
  session: Session;
  workspace: WorkspaceController;
  onDialog(request: SessionDialogRequest): void;
  className?: string;
  /** View commands of the hosting page, listed above the session actions. */
  leadingItems?: WorkbenchMenuItem[];
}) {
  const items = [
    ...leadingItems,
    ...(leadingItems.length
      ? [{ id: "leading-divider", separator: true } as const]
      : []),
    ...sessionMenuItems(session, workspace, onDialog),
  ];
  return (
    <WorkbenchMenu
      className={className ?? "icon-control session-more"}
      label={`会话操作：${sidebarSessionTitle(session)}`}
      items={items}
    >
      <MoreHorizontal size={16} />
    </WorkbenchMenu>
  );
}
