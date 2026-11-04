import type { CodingProjectInfo } from "@aura/protocol/types";

export type ConversationWorkspaceSelection = {
  projectId?: string;
  conversationId?: string;
  workspaceLocked?: boolean;
};

/** Only unbound drafts can switch workspaces or fall back to the default. */
export function canChooseConversationWorkspace(
  selection: ConversationWorkspaceSelection,
): boolean {
  return !selection.conversationId && !selection.workspaceLocked;
}

/** Keep a valid selection; older services may omit the default marker. */
export function conversationProject(
  projects: readonly CodingProjectInfo[],
  selectedId?: string,
): CodingProjectInfo | undefined {
  return (
    projects.find((project) => project.id === selectedId) ??
    projects.find((project) => project.isDefault) ??
    projects[0]
  );
}
