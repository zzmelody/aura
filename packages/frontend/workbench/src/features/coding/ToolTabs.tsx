import React, { useEffect, useRef } from "react";
import {
  ChevronDown,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { WorkbenchMenu } from "../../WorkbenchMenu";
import type { WorkspaceToolTab } from "./tool-tabs";

export function ToolTabs({
  tabs,
  selectedId,
  busy,
  closing,
  canChat,
  onSelect,
  onChat,
  onTerminal,
  onClose,
  onHide,
}: {
  tabs: WorkspaceToolTab[];
  selectedId?: string;
  busy: boolean;
  closing: string[];
  canChat: boolean;
  onSelect(id: string): void;
  onChat(): void;
  onTerminal(): void;
  onClose(tab: WorkspaceToolTab): void;
  onHide(): void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  return (
    <header className="coding-tools-header" aria-label="工具面板">
      <div
        ref={strip}
        className="coding-tool-tabs"
        role="tablist"
        aria-label="已打开的工具"
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
            !tabs.length
          )
            return;
          event.preventDefault();
          const current = tabs.findIndex((tab) => tab.id === selectedId);
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (current +
                    (event.key === "ArrowLeft" ? -1 : 1) +
                    tabs.length) %
                  tabs.length;
          onSelect(tabs[index]!.id);
          const buttons =
            strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
          buttons?.[index]?.focus();
        }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`coding-tool-tab${selectedId === tab.id ? " active" : ""}`}
            data-row-highlight
          >
            <button
              type="button"
              role="tab"
              className="row-control"
              aria-selected={selectedId === tab.id}
              title={tab.title}
              aria-controls={`tool-panel-${tab.id}`}
              id={`tool-tab-${tab.id}`}
              tabIndex={selectedId === tab.id ? 0 : -1}
              onClick={() => onSelect(tab.id)}
            >
              {tab.kind === "chat" ? (
                <MessageSquare size={13} />
              ) : (
                <SquareTerminal size={13} />
              )}
              <span>{tab.title}</span>
              {tab.status && tab.status !== "running" ? (
                <small>已退出</small>
              ) : null}
            </button>
            <button
              type="button"
              className="icon-control row-control"
              aria-label={`关闭工具：${tab.title}`}
              title={`关闭${tab.title}`}
              disabled={closing.includes(tab.id)}
              onClick={() => onClose(tab)}
            >
              {closing.includes(tab.id) ? (
                <LoaderCircle size={12} className="coding-spin" />
              ) : (
                <X size={12} />
              )}
            </button>
          </div>
        ))}
        {!tabs.length ? <span className="coding-tools-label">工具</span> : null}
      </div>
      <WorkbenchMenu
        label="打开工具"
        items={[
          {
            id: "chat",
            label: "新建侧边对话",
            icon: <MessageSquare size={14} />,
            disabled: busy || !canChat,
            action: onChat,
          },
          {
            id: "terminal",
            label: "新建终端",
            icon: <SquareTerminal size={14} />,
            disabled: busy,
            action: onTerminal,
          },
        ]}
      >
        {busy ? (
          <LoaderCircle size={15} className="coding-spin" />
        ) : (
          <Plus size={15} />
        )}
      </WorkbenchMenu>
      <div className="coding-tools-spacer" />
      {tabs.length > 1 ? (
        <WorkbenchMenu
          label="切换工具"
          items={tabs.map((tab) => ({
            id: tab.id,
            label: `${tab.id === selectedId ? "✓ " : ""}${tab.title}`,
            icon:
              tab.kind === "chat" ? (
                <MessageSquare size={14} />
              ) : (
                <SquareTerminal size={14} />
              ),
            action: () => onSelect(tab.id),
          }))}
        >
          <ChevronDown size={14} />
        </WorkbenchMenu>
      ) : null}
      <button
        type="button"
        className="icon-control"
        aria-label="收起工具面板"
        title="收起工具面板，保留任务"
        onClick={onHide}
      >
        <PanelRightClose size={15} />
      </button>
    </header>
  );
}
