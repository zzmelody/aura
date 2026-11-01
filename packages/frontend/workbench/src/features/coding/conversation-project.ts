import type { CodingProjectInfo } from "@aura/protocol/types";

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
