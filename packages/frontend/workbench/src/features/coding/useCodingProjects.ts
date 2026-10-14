import { useCallback, useEffect, useState } from "react";
import type {
  CodingConversationInfo,
  CodingProjectInfo,
} from "@aura/protocol/types";
import { listConversations, listProjects } from "./api";

export type CodingProjectsController = {
  endpoint: string;
  projects: CodingProjectInfo[];
  /** Conversations of each workspace, most recently active first. */
  conversations: Record<string, CodingConversationInfo[]>;
  /** The workspace coding mode works in; the sidebar and studio share it. */
  selectedId?: string;
  /** The open conversation; undefined starts a new one in the workspace. */
  conversationId?: string;
  select(id: string | undefined): void;
  /** Opens a conversation, or a new one when `conversationId` is omitted. */
  open(projectId: string, conversationId?: string): void;
  refresh(signal?: AbortSignal): Promise<CodingProjectInfo[]>;
  refreshConversations(projectId: string, signal?: AbortSignal): Promise<void>;
  error: string;
};

/**
 * Workspaces are the coding projects the runtime registers. The sidebar tree
 * lists them with their conversations and the coding studio shows the open
 * one, so the state lives above both.
 */
export function useCodingProjects(
  endpoint: string,
  enabled: boolean,
): CodingProjectsController {
  const [projects, setProjects] = useState<CodingProjectInfo[]>([]);
  const [conversations, setConversations] = useState<
    Record<string, CodingConversationInfo[]>
  >({});
  const [selection, setSelection] = useState<{
    projectId?: string;
    conversationId?: string;
  }>({});
  const [error, setError] = useState("");

  const refreshConversations = useCallback(
    async (projectId: string, signal?: AbortSignal) => {
      const list = await listConversations(endpoint, projectId, signal);
      setConversations((current) => ({ ...current, [projectId]: list }));
    },
    [endpoint],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const list = await listProjects(endpoint, signal);
      setProjects(list);
      setError("");
      setSelection((current) =>
        current.projectId && list.some((item) => item.id === current.projectId)
          ? current
          : { projectId: list[0]?.id },
      );
      // A workspace whose conversations fail to load still shows as a folder.
      await Promise.all(
        list.map((item) =>
          refreshConversations(item.id, signal).catch(() => {}),
        ),
      );
      return list;
    },
    [endpoint, refreshConversations],
  );

  useEffect(() => {
    if (!enabled) {
      setProjects([]);
      setConversations({});
      return;
    }
    const abort = new AbortController();
    refresh(abort.signal).catch((reason: unknown) => {
      if (!abort.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => abort.abort();
  }, [enabled, refresh]);

  const select = useCallback(
    (projectId: string | undefined) =>
      setSelection((current) =>
        current.projectId === projectId ? current : { projectId },
      ),
    [],
  );
  const open = useCallback(
    (projectId: string, conversationId?: string) =>
      setSelection({ projectId, conversationId }),
    [],
  );

  return {
    endpoint,
    projects,
    conversations,
    selectedId: selection.projectId,
    conversationId: selection.conversationId,
    select,
    open,
    refresh,
    refreshConversations,
    error,
  };
}
