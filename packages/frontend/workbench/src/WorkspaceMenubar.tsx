import React from "react";
import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";

export function WorkspaceMenubar({
  sidebarVisible,
  canBack,
  canForward,
  back,
  forward,
  toggleSidebar,
}: {
  sidebarVisible: boolean;
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
  toggleSidebar(): void;
}) {
  return (
    <header className="workspace-menubar" aria-label="应用导航栏">
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
    </header>
  );
}
