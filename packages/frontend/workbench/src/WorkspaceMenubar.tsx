import React from "react";
import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { useWorkbenchMessages } from "./i18n.ts";

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
  const { t } = useWorkbenchMessages("navigation");
  return (
    <header className="workspace-menubar" aria-label={t("navigationBar")}>
      <div className="window-navigation">
        <button
          className="icon-control"
          aria-label={t("back")}
          title={t("back")}
          disabled={!canBack}
          onClick={back}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className="icon-control"
          aria-label={t("forward")}
          title={t("forward")}
          disabled={!canForward}
          onClick={forward}
        >
          <ArrowRight size={16} />
        </button>
        <button
          className="icon-control"
          data-sidebar-toggle=""
          aria-label={t(sidebarVisible ? "hideSidebar" : "showSidebar")}
          title={t("toggleSidebar")}
          aria-expanded={sidebarVisible}
          onClick={(event) => {
            if (sidebarVisible)
              event.currentTarget.focus({ preventScroll: true });
            toggleSidebar();
          }}
        >
          <PanelLeft size={16} />
        </button>
      </div>
    </header>
  );
}
