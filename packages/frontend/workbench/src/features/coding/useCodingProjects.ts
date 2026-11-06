import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  errorMessage,
  MessageError,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  conversationMessage as message,
  useConversationMessages,
} from "../../conversation-messages";
import type {
  CodingConversationInfo,
  CodingPermission,
  CodingProjectInfo,
  ChatModelSelection,
  FlowMode,
  PersonalAssistantInfo,
} from "@aura/protocol/types";
import type { SessionStatus } from "../../sidebarSessions";
import {
  conversationSides,
  PERSONAL_ASSISTANT_SESSION_ID,
} from "@aura/protocol/conversations";
import {
  archiveConversation,
  closeConversation,
  closeSideChat,
  listConversations,
  listProjects,
  openSideChat,
  saveConversationModel,
  saveConversationPermission,
  personalAssistant,
} from "./api";
import { conversationInfoStatus, isActiveStatus } from "./conversationStatus";
import {
  canChooseConversationWorkspace,
  conversationProject,
  type ConversationWorkspaceSelection,
} from "./conversation-project";
import { createAssistantLoader } from "./assistant-loader";
import { startupCache } from "../../startup-cache.ts";

/** How often the sidebar re-reads statuses while some turn is still running. */
const ACTIVE_POLL_MS = 3000;

export type CodingProjectsController = {
  endpoint: string;
  projects: CodingProjectInfo[];
  ready: boolean;
  assistant?: PersonalAssistantInfo;
  assistantLoading: boolean;
  loadAssistant(create?: boolean): Promise<boolean>;
  /** Conversations of each workspace, most recently active first. */
  conversations: Record<string, CodingConversationInfo[]>;
  conversationErrors: Record<string, string>;
  /** The workspace coding mode works in; the sidebar and studio share it. */
  selectedId?: string;
  canChooseWorkspace: boolean;
  /** The open conversation; undefined starts a new one in the workspace. */
  conversationId?: string;
  branchFrom?: string;
  branchAt?: number;
  continueIn(projectId: string): void;
  fork(projectId: string, sessionId: string, endSeq: number): void;
  newChat(preferredProjectId?: string): void;
  selectModel(
    sessionId: string,
    mode: FlowMode,
    selection: ChatModelSelection,
  ): Promise<void>;
  pendingPermissions: Readonly<Partial<Record<string, CodingPermission>>>;
  selectPermission(
    sessionId: string,
    permission: CodingPermission,
  ): Promise<void>;
  select(id: string | undefined): void;
  /** Opens a conversation, or a draft bound to the given workspace. */
  open(projectId: string, conversationId?: string): void;
  refresh(signal?: AbortSignal): Promise<CodingProjectInfo[]>;
  refreshConversations(
    projectId: string,
    signal?: AbortSignal,
    metadataOnly?: boolean,
  ): Promise<void>;
  openSide(projectId: string, parentId: string): Promise<string>;
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
  statusesEnabled = true,
): CodingProjectsController {
  const { i18n } = useConversationMessages();
  const [restored] = useState(() => startupCache.sidebar(endpoint));
  const [projects, setProjects] = useState(restored.projects);
  const [dataEndpoint, setDataEndpoint] = useState(endpoint);
  const [readyEndpoint, setReadyEndpoint] = useState<string>();
  const [conversations, setConversations] = useState<
    Record<string, CodingConversationInfo[]>
  >(restored.conversations);
  const [conversationErrors, setConversationErrors] = useState<
    Record<string, string | MessageReference>
  >({});
  const [selection, setSelection] = useState<
    ConversationWorkspaceSelection & { branchFrom?: string; branchAt?: number }
  >({ projectId: conversationProject(restored.projects)?.id });
  const [error, setError] = useState<string | MessageReference>("");
  const [pendingPermissions, setPendingPermissions] = useState<
    Partial<Record<string, CodingPermission>>
  >({});
  const permissionWrites = useRef(new Set<string>());
  const currentEndpoint = useRef(endpoint);
  currentEndpoint.current = endpoint;
  const [loadedAssistant, setLoadedAssistant] = useState<{
    endpoint: string;
    info: PersonalAssistantInfo;
  }>();
  const [assistantRequests, setAssistantRequests] = useState(0);
  // Ignore lists requested before a successful mutation changed these rows.
  const versions = useRef(new Map<string, number>());
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
          previous?.messageKey === status?.messageKey
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
    async (projectId: string, signal?: AbortSignal, metadataOnly = false) => {
      const version = versions.current.get(projectId);
      let list: CodingConversationInfo[];
      try {
        list = await listConversations(
          endpoint,
          projectId,
          signal,
          !metadataOnly,
        );
      } catch (reason) {
        if (!signal?.aborted && version === versions.current.get(projectId))
          setConversationErrors((current) => ({
            ...current,
            [projectId]: message("conversationListFailed"),
          }));
        throw reason;
      }
      if (signal?.aborted) return;
      if (version !== versions.current.get(projectId)) return;
      startupCache.saveConversations(endpoint, projectId, list);
      setConversationErrors((current) => {
        if (!current[projectId]) return current;
        const next = { ...current };
        delete next[projectId];
        return next;
      });
      setConversations((current) => {
        if (!metadataOnly) return { ...current, [projectId]: list };
        const previous = new Map(
          (current[projectId] ?? []).map((item) => [item.id, item]),
        );
        return {
          ...current,
          [projectId]: list.map((item) => {
            const saved = previous.get(item.id);
            return {
              ...(saved?.lastTurnStatus
                ? { lastTurnStatus: saved.lastTurnStatus }
                : {}),
              ...(saved?.waitingForAnswer
                ? { waitingForAnswer: true as const }
                : {}),
              ...item,
            };
          }),
        };
      });
      if (metadataOnly) return;
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

  const requestAssistant = useCallback(
    async (create: boolean, signal: AbortSignal) => {
      setAssistantRequests((current) => current + 1);
      try {
        const info = await personalAssistant(endpoint, create, signal);
        if (signal.aborted || !info) return false;
        versions.current.set(
          info.project.id,
          (versions.current.get(info.project.id) ?? 0) + 1,
        );
        setLoadedAssistant({ endpoint, info });
        setProjects((current) =>
          current.some((project) => project.id === info.project.id)
            ? current
            : [...current, info.project],
        );
        setConversations((current) => ({
          ...current,
          [info.project.id]: [
            info.conversation,
            ...(current[info.project.id] ?? []).filter(
              (conversation) => conversation.id !== info.conversation.id,
            ),
          ],
        }));
        // A list started before the assistant opened is now stale. Read a new
        // one so the other tasks remain visible even during initial restore.
        void refreshConversations(info.project.id, signal, true).catch(
          () => {},
        );
        setError("");
        return true;
      } catch (reason) {
        if (!signal.aborted) setError(errorMessage(reason));
        return false;
      } finally {
        setAssistantRequests((current) => current - 1);
      }
    },
    [endpoint, refreshConversations],
  );
  const assistantLoader = useMemo(
    () => createAssistantLoader(requestAssistant),
    [requestAssistant],
  );
  useEffect(() => assistantLoader.cancel, [assistantLoader]);

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
      if (signal?.aborted) return list;
      startupCache.saveProjects(endpoint, list);
      setProjects(list);
      const projectIds = new Set(list.map((project) => project.id));
      setConversations((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => projectIds.has(id)),
        ),
      );
      setError("");
      setSelection((current) =>
        !canChooseConversationWorkspace(current) ||
        (current.projectId &&
          list.some((item) => item.id === current.projectId))
          ? current
          : {
              projectId: conversationProject(list)?.id,
            },
      );
      setReadyEndpoint(endpoint);
      // A workspace whose conversations fail to load still shows as a folder.
      await Promise.all(
        list.map((item) =>
          refreshConversations(item.id, signal, true).catch(() => {}),
        ),
      );
      return list;
    },
    [endpoint, refreshConversations],
  );

  useEffect(() => {
    setPendingPermissions({});
    if (!enabled) {
      setProjects([]);
      setConversations({});
      setConversationErrors({});
      setReadyEndpoint(undefined);
      return;
    }
    const saved = startupCache.sidebar(endpoint);
    setDataEndpoint(endpoint);
    setProjects(saved.projects);
    setSelection({ projectId: conversationProject(saved.projects)?.id });
    setConversations(saved.conversations);
    setConversationErrors({});
    setReadyEndpoint(undefined);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = () =>
      refresh(abort.signal).catch((reason: unknown) => {
        if (!abort.signal.aborted) {
          setError(errorMessage(reason));
          timer = setTimeout(read, 3000);
        }
      });
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [enabled, refresh, endpoint]);

  // Opening a workspace needs its records, not a scan of every task's log.
  // Status enrichment starts only after the boot-critical model read settles.
  useEffect(() => {
    if (!enabled || !statusesEnabled || readyEndpoint !== endpoint) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      for (const project of projects)
        void refreshConversations(project.id, abort.signal).catch(() => {});
    }, 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    enabled,
    statusesEnabled,
    readyEndpoint,
    endpoint,
    projects,
    refreshConversations,
  ]);

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
    if (!enabled || !statusesEnabled || !activeProjects) return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      for (const projectId of activeProjects.split("\n"))
        void refreshConversations(projectId, abort.signal).catch(() => {});
    }, ACTIVE_POLL_MS);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [enabled, statusesEnabled, activeProjects, refreshConversations]);

  const select = useCallback(
    (projectId: string | undefined) =>
      setSelection((current) =>
        current.projectId === projectId ? current : { projectId },
      ),
    [],
  );
  const open = useCallback(
    (projectId: string, conversationId?: string) =>
      setSelection({
        projectId,
        conversationId,
        workspaceLocked: !conversationId,
      }),
    [],
  );

  const mutate = useCallback(
    async (projectId: string, action: () => Promise<unknown>) => {
      try {
        await action();
        versions.current.set(
          projectId,
          (versions.current.get(projectId) ?? 0) + 1,
        );
        await refreshConversations(projectId);
        setError("");
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [refreshConversations],
  );

  const openSide = useCallback(
    async (projectId: string, parentId: string) => {
      try {
        const { sessionId } = await openSideChat(endpoint, parentId);
        versions.current.set(
          projectId,
          (versions.current.get(projectId) ?? 0) + 1,
        );
        setConversations((current) => ({
          ...current,
          [projectId]: (current[projectId] ?? []).map((item) =>
            item.id === parentId
              ? {
                  ...item,
                  sideConversations: [
                    ...conversationSides(item),
                    {
                      id: sessionId,
                      title: "新旁支对话",
                      createdAt: Date.now(),
                    },
                  ],
                }
              : item,
          ),
        }));
        setError("");
        // Creation has succeeded even if this follow-up list is unavailable.
        void refreshConversations(projectId).catch(() => {
          setError(message("sideCreatedRefreshFailed"));
        });
        return sessionId;
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [endpoint, refreshConversations],
  );
  const closeSide = useCallback(
    async (projectId: string, sessionId: string) => {
      try {
        await closeSideChat(endpoint, sessionId);
        versions.current.set(
          projectId,
          (versions.current.get(projectId) ?? 0) + 1,
        );
        setConversations((current) => ({
          ...current,
          [projectId]: (current[projectId] ?? []).map((item) => {
            const sides = conversationSides(item).filter(
              (side) => side.id !== sessionId,
            );
            return {
              ...item,
              sideConversations: sides,
              sideSessionId: sides[0]?.id,
              sideModelConfig: sides[0]?.modelConfig,
            };
          }),
        }));
        setError("");
        // A failed refresh must never put a successfully closed panel back.
        void refreshConversations(projectId).catch(() => {
          setError(message("sideClosedRefreshFailed"));
        });
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [endpoint, refreshConversations],
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

  const assistant =
    loadedAssistant?.endpoint === endpoint ? loadedAssistant.info : undefined;
  const assistantConversation =
    assistant && dataEndpoint === endpoint
      ? conversations[assistant.project.id]?.find(
          (item) => item.id === PERSONAL_ASSISTANT_SESSION_ID,
        )
      : undefined;
  return {
    endpoint,
    projects: dataEndpoint === endpoint ? projects : [],
    ready: readyEndpoint === endpoint,
    assistant:
      assistant && assistantConversation
        ? { ...assistant, conversation: assistantConversation }
        : assistant,
    assistantLoading: assistantRequests > 0,
    loadAssistant: assistantLoader.load,
    conversations: dataEndpoint === endpoint ? conversations : {},
    conversationErrors:
      dataEndpoint === endpoint
        ? Object.fromEntries(
            Object.entries(conversationErrors).map(([id, problem]) => [
              id,
              messageText(problem, i18n),
            ]),
          )
        : {},
    selectedId: dataEndpoint === endpoint ? selection.projectId : undefined,
    canChooseWorkspace:
      dataEndpoint !== endpoint || canChooseConversationWorkspace(selection),
    conversationId:
      dataEndpoint === endpoint ? selection.conversationId : undefined,
    branchFrom: dataEndpoint === endpoint ? selection.branchFrom : undefined,
    branchAt: dataEndpoint === endpoint ? selection.branchAt : undefined,
    fork: (projectId, sessionId, endSeq) =>
      setSelection({ projectId, branchFrom: sessionId, branchAt: endSeq }),
    continueIn: (projectId) =>
      setSelection((current) =>
        current.projectId === projectId
          ? current
          : {
              projectId,
              branchFrom: current.conversationId ?? current.branchFrom,
              branchAt: current.branchAt,
            },
      ),
    newChat: (preferredProjectId) =>
      setSelection({
        projectId: preferredProjectId ?? conversationProject(projects)?.id,
      }),
    selectModel: (sessionId, mode, selection) => {
      const parent = Object.values(conversations)
        .flat()
        .find(
          (item) =>
            item.id === sessionId ||
            conversationSides(item).some((side) => side.id === sessionId),
        );
      if (!parent)
        return Promise.reject(
          new MessageError(message("conversationNotSaved")),
        );
      setConversations((current) => ({
        ...current,
        [parent.projectId]: (current[parent.projectId] ?? []).map((item) =>
          item.id === parent.id
            ? parent.id === sessionId
              ? {
                  ...item,
                  modelConfig: { ...item.modelConfig, [mode]: selection },
                }
              : {
                  ...item,
                  sideConversations: conversationSides(item).map((side) =>
                    side.id === sessionId
                      ? {
                          ...side,
                          modelConfig: {
                            ...side.modelConfig,
                            [mode]: selection,
                          },
                        }
                      : side,
                  ),
                }
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
    pendingPermissions: dataEndpoint === endpoint ? pendingPermissions : {},
    selectPermission: async (sessionId, permission) => {
      const parent = Object.values(conversations)
        .flat()
        .find(
          (item) =>
            item.id === sessionId ||
            conversationSides(item).some((side) => side.id === sessionId),
        );
      if (!parent) throw new MessageError(message("conversationNotSaved"));
      const key = JSON.stringify([endpoint, sessionId]);
      if (permissionWrites.current.has(key)) return;
      permissionWrites.current.add(key);
      setPendingPermissions((current) => ({
        ...current,
        [sessionId]: permission,
      }));
      try {
        await saveConversationPermission(endpoint, sessionId, permission);
        if (currentEndpoint.current !== endpoint) return;
        const { projectId } = parent;
        versions.current.set(
          projectId,
          (versions.current.get(projectId) ?? 0) + 1,
        );
        setConversations((current) => ({
          ...current,
          [projectId]: (current[projectId] ?? []).map((item) => {
            if (item.id !== parent.id) return item;
            if (item.id === sessionId) return { ...item, permission };
            return {
              ...item,
              sideConversations: conversationSides(item).map((side) =>
                side.id === sessionId ? { ...side, permission } : side,
              ),
            };
          }),
        }));
      } catch (error) {
        if (currentEndpoint.current === endpoint)
          await refreshConversations(parent.projectId).catch(() => {});
        throw error;
      } finally {
        permissionWrites.current.delete(key);
        if (currentEndpoint.current === endpoint)
          setPendingPermissions((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
      }
    },
    select,
    open,
    refresh,
    refreshConversations,
    openSide,
    closeSide,
    archive,
    close,
    statuses: dataEndpoint === endpoint ? statuses : {},
    reportStatus,
    error: messageText(error, i18n),
  };
}
