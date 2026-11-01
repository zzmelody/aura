import React from "react";
import {
  Archive,
  Copy,
  Ellipsis,
  FolderOpen,
  Moon,
  Pencil,
  Settings2,
  Sun,
} from "lucide-react";
import { FlowIcon } from "./FlowIcon";
import { WorkbenchMenu } from "./WorkbenchMenu";
import { writeClipboard } from "./clipboard";
import { useToast } from "./toast";
import type { WorkspaceController } from "./useWorkspace";
import type { Tab } from "./types";
import type { SessionDialogRequest } from "./SessionActions";

/** Application commands live in the sidebar footer; the title bar only navigates. */
export function WorkspaceMenu({
  workspace,
  dark,
  settingsSelected,
  toggleTheme,
  navigate,
  onArchived,
  onDialog,
}: {
  workspace: WorkspaceController;
  dark: boolean;
  settingsSelected: boolean;
  toggleTheme(): void;
  navigate(tab: Tab): void;
  onArchived(): void;
  onDialog(request: SessionDialogRequest): void;
}) {
  const toast = useToast();
  const active = workspace.active;
  const copy = () => {
    if (!active) return;
    const text = active.messages
      .map(
        (message) =>
          `${message.role === "user" ? "用户" : "Aura"}\n${message.text}`,
      )
      .join("\n\n");
    void writeClipboard(text).then(
      () => toast({ message: "对话内容已复制", duration: 2200 }),
      () => toast({ message: "复制失败，请重试", duration: 2200 }),
    );
  };
  return (
    <WorkbenchMenu
      label="应用菜单"
      className={`sidebar-workspace${settingsSelected ? " selected" : ""}`}
      items={[
        {
          id: "flows",
          label: "工作流",
          icon: <FlowIcon size={15} />,
          action: () => navigate("flows"),
        },
        { id: "session-divider", separator: true },
        {
          id: "rename",
          label: "重命名会话",
          icon: <Pencil size={15} />,
          disabled: !active,
          action: () =>
            active && onDialog({ sessionId: active.id, mode: "rename" }),
        },
        {
          id: "copy",
          label: "复制对话内容",
          icon: <Copy size={15} />,
          disabled: !active?.messages.length,
          action: copy,
        },
        { id: "view-divider", separator: true },
        {
          id: "theme",
          label: dark ? "浅色外观" : "深色外观",
          icon: dark ? <Sun size={15} /> : <Moon size={15} />,
          action: toggleTheme,
        },
        {
          id: "archived",
          label: "已归档会话",
          icon: <Archive size={15} />,
          action: onArchived,
        },
        { id: "settings-divider", separator: true },
        {
          id: "settings",
          label: "设置",
          icon: <Settings2 size={15} />,
          action: () => navigate("settings"),
        },
      ]}
    >
      <span className="sidebar-avatar">
        <FolderOpen size={18} />
      </span>
      <span>本地工作区</span>
      <Ellipsis size={16} />
    </WorkbenchMenu>
  );
}
