import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodingConversationInfo,
  CodingProjectInfo,
  ChatModelSelection,
  FlowMode,
} from "@aura/protocol/types";
import type { SessionStatus } from "../../sidebarSessions";
import {
  archiveConversation,
  closeConversation,
  closeSideChat,
  listConversations,
  listProjects,
  openSideChat,
  saveConversationModel,
} from "./api";
import { conversationInfoStatus, isActiveStatus } from "./conversationStatus";

/** How often the sidebar re-reads statuses while some turn is still running. */
const ACTIVE_POLL_MS = 3000;

export type CodingProjectsController = {
  endpoint: string;
  projects: CodingProjectInfo[];
  /** Conversations of each workspace, most recently active first. */
  conversations: Record<string, CodingConversationInfo[]>;
  /** The workspace coding mode works in; the sidebar and studio share it. */
  selectedId?: string;
  /** The open conversation; undefined starts a new one in the workspace. */
  conversationId?: string;
  branchFrom?: string;
  continueIn(projectId: string): void;
  newChat(): void;
  selectModel(
    sessionId: string,
    mode: FlowMode,
    selection: ChatModelSelection,
  ): Promise<void>;
  select(id: string | undefined): void;
  /** Opens a conversation, or a new one when `conversationId` is omitted. */
  open(projectId: string, conversationId?: string): void;
  refresh(signal?: AbortSignal): Promise<CodingProjectInfo[]>;
  refreshConversations(projectId: string, signal?: AbortSignal): Promise<void>;
  openSide(projectId: string, parentId: string): Promise<void>;
  closeSide(projectId: string, sessionId: string): Promise<void>;
  archive(
    projectId: string,
    sessionId: string,
    archived: boolean,
  ): Promise<void>;
  close(projectId: string, sessionId: string): Promise<void>;
  /** Execution status of conversations opened on this page, by session id. */
  statuses: Record<string, SessionStatus>;
  /** A pane reports its latest turn's status; undefined clears it. */
  reportStatus(sessionId: string, status: SessionStatus | undefined): void;
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
    branchFrom?: string;
  }>({});
  const [error, setError] = useState("");
  /**
   * Live statuses reported by the open pane. They are fresher than the list
   * for the conversation on screen. Other entries are kept until the next list
   * refresh, so switching away never blanks a row.
   */
  const [live, setLive] = useState<Record<string, SessionStatus>>({});
  /** The conversation the pane reported last; its live status outranks the list. */
  const onScreen = useRef<string | undefined>(undefined);

  const reportStatus = useCallback(
    (sessionId: string, status: SessionStatus | undefined) => {
      onScreen.current = sessionId;
      setLive((current) => {
        const previous = current[sessionId];
        if (
          previous?.kind === status?.kind &&
          previous?.label === status?.label
        )
          return current;
        const next = { ...current };
        if (status) next[sessionId] = status;
        else delete next[sessionId];
        return next;
      });
    },
    [],
  );

  const refreshConversations = useCallback(
    async (projectId: string, signal?: AbortSignal) => {
      const list = await listConversations(endpoint, projectId, signal);
      setConversations((current) => ({ ...current, [projectId]: list }));
      // The list now carries authoritative statuses for these rows, so live
      // values survive only for the conversation still on screen.
      const listed = new Set(list.map((item) => item.id));
      setLive((current) => {
        const entries = Object.entries(current).filter(
          ([id]) => !listed.has(id) || id === onScreen.current,
        );
        return entries.length === Object.keys(current).length
          ? current
          : Object.fromEntries(entries);
      });
    },
    [endpoint],
  );

  /** Server status for every listed row, overlaid with the pane's live status. */
  const statuses = useMemo(() => {
    const merged: Record<string, SessionStatus> = {};
    for (const list of Object.values(conversations))
      for (const item of list) {
        const status = conversationInfoStatus(item);
        if (status) merged[item.id] = status;
      }
    return { ...merged, ...live };
  }, [conversations, live]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const list = await listProjects(endpoint, signal);
      setProjects(list);
      setError("");
      setSelection((current) =>
        current.projectId && list.some((item) => item.id === current.projectId)
          ? current
          : {
              projectId: list.find((item) => item.isDefault)?.id ?? list[0]?.id,
            },
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

  // Turns run on the server whether or not their conversation is open, so the
  // sidebar polls the projects that have one until each settles.
  const activeProjects = useMemo(
    () =>
      Object.entries(conversations)
        .filter(([, list]) =>
          list.some((item) => isActiveStatus(conversationInfoStatus(item))),
        )
        .map(([projectId]) => projectId)
        .sort()
        .join("\n"),
    [conversations],
  );
  useEffect(() => {
    if (!enabled || !activeProjects) return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      for (const projectId of activeProjects.split("\n"))
        void refreshConversations(projectId, abort.signal).catch(() => {});
    }, ACTIVE_POLL_MS);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [enabled, activeProjects, refreshConversations]);

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

  const mutate = useCallback(
    async (projectId: string, action: () => Promise<unknown>) => {
      try {
        await action();
        await refreshConversations(projectId);
        setError("");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      }
    },
    [refreshConversations],
  );

  const openSide = useCallback(
    (projectId: string, parentId: string) =>
      mutate(projectId, () => openSideChat(endpoint, parentId)),
    [endpoint, mutate],
  );
  const closeSide = useCallback(
    (projectId: string, sessionId: string) =>
      mutate(projectId, () => closeSideChat(endpoint, sessionId)),
    [endpoint, mutate],
  );
  const archive = useCallback(
    (projectId: string, sessionId: string, archived: boolean) =>
      mutate(projectId, () =>
        archiveConversation(endpoint, sessionId, archived),
      ),
    [endpoint, mutate],
  );
  const close = useCallback(
    async (projectId: string, sessionId: string) => {
      await mutate(projectId, () => closeConversation(endpoint, sessionId));
      setSelection((current) =>
        current.conversationId === sessionId ? { projectId } : current,
      );
    },
    [endpoint, mutate],
  );

  return {
    endpoint,
    projects,
    conversations,
    selectedId: selection.projectId,
    conversationId: selection.conversationId,
    branchFrom: selection.branchFrom,
    continueIn: (projectId) =>
      setSelection((current) =>
        current.projectId === projectId
          ? current
          : {
              projectId,
              ...(current.conversationId
                ? { branchFrom: current.conversationId }
                : {}),
            },
      ),
    newChat: () =>
      setSelection({ projectId: projects.find((item) => item.isDefault)?.id }),
    selectModel: (sessionId, mode, selection) => {
      const parent = Object.values(conversations)
        .flat()
        .find(
          (item) => item.id === sessionId || item.sideSessionId === sessionId,
        );
      if (!parent)
        return Promise.reject(new Error("对话尚未保存，请稍后再试。"));
      const field = parent.id === sessionId ? "modelConfig" : "sideModelConfig";
      setConversations((current) => ({
        ...current,
        [parent.projectId]: (current[parent.projectId] ?? []).map((item) =>
          item.id === parent.id
            ? { ...item, [field]: { ...item[field], [mode]: selection } }
            : item,
        ),
      }));
      return mutate(parent.projectId, () =>
        saveConversationModel(endpoint, sessionId, mode, selection),
      ).catch(async (error: unknown) => {
        await refreshConversations(parent.projectId).catch(() => {});
        throw error;
      });
    },
    select,
    open,
    refresh,
    refreshConversations,
    openSide,
    closeSide,
    archive,
    close,
    statuses,
    reportStatus,
    error,
  };
}
