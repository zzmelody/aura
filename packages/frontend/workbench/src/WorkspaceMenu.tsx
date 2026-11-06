import React from "react";
import { Ellipsis, FolderOpen, Moon, Settings2, Sun } from "lucide-react";
import { WorkbenchMenu } from "./WorkbenchMenu";
import type { Tab } from "./types";
import { useWorkbenchMessages } from "./i18n.ts";

/** Appearance and settings live in the sidebar footer, independent of sessions. */
export function WorkspaceMenu({
  dark,
  settingsSelected,
  toggleTheme,
  navigate,
}: {
  dark: boolean;
  settingsSelected: boolean;
  toggleTheme(): void;
  navigate(tab: Tab): void;
}) {
  const { t } = useWorkbenchMessages("navigation");
  return (
    <WorkbenchMenu
      label={t("appMenu")}
      className={`sidebar-workspace${settingsSelected ? " selected" : ""}`}
      items={[
        {
          id: "theme",
          label: t(dark ? "lightAppearance" : "darkAppearance"),
          icon: dark ? <Sun size={15} /> : <Moon size={15} />,
          action: toggleTheme,
        },
        {
          id: "settings",
          label: t("settings"),
          icon: <Settings2 size={15} />,
          action: () => navigate("settings"),
        },
      ]}
    >
      <span className="sidebar-avatar">
        <FolderOpen size={18} />
      </span>
      <span>{t("localWorkspace")}</span>
      <Ellipsis size={16} />
    </WorkbenchMenu>
  );
}
