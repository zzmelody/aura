import type {
  CodingSideConversationInfo,
  WorkspaceTerminalInfo,
} from "@aura/protocol/types";

export interface WorkspaceToolTab {
  id: string;
  kind: "chat" | "terminal" | "browser";
  title: string;
  status?: WorkspaceTerminalInfo["status"];
}

export function workspaceToolTabs(
  sides: CodingSideConversationInfo[],
  terminals: WorkspaceTerminalInfo[],
  browsers: ReadonlyArray<{ id: string; title: string }> = [],
): WorkspaceToolTab[] {
  return [
    ...sides.map((side): WorkspaceToolTab => ({
      id: side.id,
      kind: "chat",
      title: ["旁支对话", "新旁支对话"].includes(side.title)
        ? "新侧边对话"
        : side.title,
    })),
    ...terminals.map((terminal, index): WorkspaceToolTab => ({
      id: terminal.id,
      kind: "terminal",
      title: `${terminal.title}${terminals.length > 1 ? ` ${index + 1}` : ""}`,
      status: terminal.status,
    })),
    ...browsers.map(({ id, title }): WorkspaceToolTab => ({
      id,
      kind: "browser",
      title,
    })),
  ];
}

/** A terminal stays selected when another main chat in its workspace opens. */
export function selectedToolId(
  tabs: WorkspaceToolTab[],
  preferred?: string,
): string | undefined {
  return tabs.find((tab) => tab.id === preferred)?.id ?? tabs[0]?.id;
}
