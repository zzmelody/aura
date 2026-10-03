import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  GitBranch,
  Moon,
  PanelLeft,
  Pencil,
  Settings2,
  SquarePen,
  Sun,
} from "lucide-react";
import type { WorkspaceController } from "./useWorkspace";
import type { Tab } from "./types";
import type { SessionDialogRequest } from "./SessionActions";
import { WorkbenchMenu } from "./WorkbenchMenu";
import { writeClipboard } from "./clipboard";

export function WorkspaceMenubar({
  workspace,
  dark,
  sidebarVisible,
  canBack,
  canForward,
  back,
  forward,
  toggleSidebar,
  toggleTheme,
  navigate,
  start,
  onArchived,
  onDialog,
}: {
  workspace: WorkspaceController;
  dark: boolean;
  sidebarVisible: boolean;
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
  toggleSidebar(): void;
  toggleTheme(): void;
  navigate(tab: Tab): void;
  start(): void;
  onArchived(): void;
  onDialog(request: SessionDialogRequest): void;
}) {
  const [copyStatus, setCopyStatus] = useState<"copied" | "error">();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const active = workspace.active;
  const copy = () => {
    if (!active) return;
    const text = active.messages
      .map(
        (message) =>
          `${message.role === "user" ? "用户" : "Aura"}\n${message.text}`,
      )
      .join("\n\n");
    void writeClipboard(text)
      .then(
        () => setCopyStatus("copied"),
        () => setCopyStatus("error"),
      )
      .finally(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopyStatus(undefined), 2200);
      });
  };
  return (
    <header className="workspace-menubar" aria-label="应用菜单栏">
      <div className="window-navigation">
        <button
          className="icon-control"
          aria-label="后退"
          title="后退"
          disabled={!canBack}
          onClick={back}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className="icon-control"
          aria-label="前进"
          title="前进"
          disabled={!canForward}
          onClick={forward}
        >
          <ArrowRight size={16} />
        </button>
        <button
          className="icon-control"
          aria-label={sidebarVisible ? "收起侧栏" : "展开会话列表"}
          title="切换侧栏"
          aria-pressed={sidebarVisible}
          onClick={toggleSidebar}
        >
          <PanelLeft size={16} />
        </button>
      </div>
      <nav className="application-menus" aria-label="应用菜单">
        <WorkbenchMenu
          label="文件"
          className="menubar-button"
          items={[
            {
              id: "new",
              label: "新对话",
              icon: <SquarePen size={15} />,
              action: start,
            },
            {
              id: "flows",
              label: "工作流",
              icon: <GitBranch size={15} />,
              action: () => navigate("flows"),
            },
            {
              id: "archive",
              label: "已归档会话",
              icon: <Archive size={15} />,
              action: onArchived,
            },
            { id: "divider", separator: true },
            {
              id: "settings",
              label: "设置",
              icon: <Settings2 size={15} />,
              action: () => navigate("settings"),
            },
          ]}
        >
          文件
        </WorkbenchMenu>
        <WorkbenchMenu
          label="编辑"
          className="menubar-button"
          items={[
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
          ]}
        >
          编辑
        </WorkbenchMenu>
        <WorkbenchMenu
          label="视图"
          className="menubar-button"
          items={[
            {
              id: "sidebar",
              label: sidebarVisible ? "收起侧栏" : "展开侧栏",
              icon: <PanelLeft size={15} />,
              action: toggleSidebar,
            },
            {
              id: "theme",
              label: dark ? "浅色外观" : "深色外观",
              icon: dark ? <Sun size={15} /> : <Moon size={15} />,
              action: toggleTheme,
            },
            { id: "divider", separator: true },
            {
              id: "history",
              label: "全部记录",
              action: () => navigate("history"),
            },
            {
              id: "archived",
              label: "已归档会话",
              icon: <Archive size={15} />,
              action: onArchived,
            },
          ]}
        >
          视图
        </WorkbenchMenu>
        <WorkbenchMenu
          label="帮助"
          className="menubar-button"
          items={[
            {
              id: "settings",
              label: "关于 Aura 与连接设置",
              icon: <Settings2 size={15} />,
              action: () => navigate("settings"),
            },
          ]}
        >
          帮助
        </WorkbenchMenu>
      </nav>
      <span className="menubar-title">Aura</span>
      {copyStatus ? (
        <span className="menubar-feedback" role="status">
          {copyStatus === "copied" ? (
            <>
              <Check size={12} /> 已复制
            </>
          ) : (
            "复制失败，请重试"
          )}
        </span>
      ) : null}
    </header>
  );
}
