import { useToolMessages } from "../../tool-messages.ts";
import React, { useEffect, useRef } from "react";
import {
  ChevronDown,
  Globe,
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
  onBrowser,
  onClose,
  hideButtonRef,
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
  onBrowser?(): void;
  onClose(tab: WorkspaceToolTab): void;
  hideButtonRef: React.Ref<HTMLButtonElement>;
  onHide(): void;
}) {
  const { t } = useToolMessages();
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  return (
    <header className="coding-tools-header" aria-label={t("panel")}>
      <div
        ref={strip}
        className="coding-tool-tabs"
        role="tablist"
        aria-label={t("opened")}
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
              <ToolIcon kind={tab.kind} size={13} />
              <span>{tab.title}</span>
              {tab.status && tab.status !== "running" ? (
                <small>{t("exited")}</small>
              ) : null}
            </button>
            <button
              type="button"
              className="icon-control row-control"
              aria-label={t("closeTool", { name: tab.title })}
              title={t("closeTool", { name: tab.title })}
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
        {!tabs.length ? (
          <span className="coding-tools-label">{t("tools")}</span>
        ) : null}
      </div>
      <WorkbenchMenu
        label={t("openTool")}
        items={[
          {
            id: "chat",
            label: t("newSideChat"),
            icon: <MessageSquare size={14} />,
            disabled: busy || !canChat,
            action: onChat,
          },
          {
            id: "terminal",
            label: t("newTerminal"),
            icon: <SquareTerminal size={14} />,
            disabled: busy,
            action: onTerminal,
          },
          ...(onBrowser
            ? [
                {
                  id: "browser",
                  label: t("newBrowser"),
                  icon: <Globe size={14} />,
                  action: onBrowser,
                },
              ]
            : []),
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
          label={t("switchTool")}
          items={tabs.map((tab) => ({
            id: tab.id,
            label: `${tab.id === selectedId ? "✓ " : ""}${tab.title}`,
            icon: <ToolIcon kind={tab.kind} size={14} />,
            action: () => onSelect(tab.id),
          }))}
        >
          <ChevronDown size={14} />
        </WorkbenchMenu>
      ) : null}
      <button
        ref={hideButtonRef}
        type="button"
        className="icon-control"
        aria-label={t("hidePanel")}
        title={t("hidePanelHint")}
        onClick={onHide}
      >
        <PanelRightClose size={15} />
      </button>
    </header>
  );
}

function ToolIcon({
  kind,
  size,
}: {
  kind: WorkspaceToolTab["kind"];
  size: number;
}) {
  const Icon = {
    chat: MessageSquare,
    terminal: SquareTerminal,
    browser: Globe,
  }[kind];
  return <Icon size={size} />;
}
