import { useEffect, useRef, useState } from "react";
import { initialState, restoreState, STORAGE_KEY } from "@aura/core";
import { streamDemo } from "@aura/demo";
import type { ChatImage, Message, Session, Workspace } from "@aura/core/types";
import type {
  FlowCatalogEntry,
  FlowMode,
  JsonValue,
} from "@aura/protocol/types";
import { useWorkflowSessions } from "./useWorkflowSessions";
import {
  chatHistory,
  isWorkflowActive,
  isWorkflowOpen,
  messageEndpoint,
  workflowRunKey,
} from "./workflowSessions";

const id = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function useWorkspace() {
  const [state, setState] = useState<Workspace>(initialState() as Workspace);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const stateRef = useRef(state);
  stateRef.current = state;
  const workflows = useWorkflowSessions(state, setState, ready);
  const workflowRunning = state.sessions
    .filter((session) =>
      session.messages.some(
        (message) =>
          message.workflowRunId && isWorkflowActive(message.workflowPhase),
      ),
    )
    .map((session) => session.id);
  const allRunningIds = [
    ...new Set([...runningIds, ...workflowRunning, ...workflows.submitting]),
  ];
  useEffect(() => {
    let mounted = true;
    const activeControllers = controllers.current;
    try {
      const raw = globalThis.localStorage.getItem(STORAGE_KEY);
      if (mounted && raw) setState(restoreState(JSON.parse(raw)) as Workspace);
    } catch {
      if (mounted) setSaveError("无法读取本地记录，本次会话仍可使用。");
    } finally {
      if (mounted) setReady(true);
    }
    return () => {
      mounted = false;
      for (const controller of activeControllers.values()) controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      try {
        globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        setSaveError("本地存储空间不足，最新对话可能无法保存。");
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [state, ready]);
  const active = state.sessions.find((s) => s.id === activeId);
  function updateMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Message>,
  ) {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.id === messageId ? { ...m, ...patch } : m,
              ),
            }
          : s,
      ),
    }));
  }
  async function send(
    text: string,
    retryLast = false,
    context?: string,
    images: ChatImage[] = [],
  ) {
    if (stateRef.current.provider !== "offline") return;
    if ((!text.trim() && !images.length) || text.length > 4000) return;
    const current = stateRef.current;
    if (
      current.sessions.find((session) => session.id === activeIdRef.current)
        ?.workflow
    )
      return;
    const draftKey = activeIdRef.current ?? "new";
    const sessionId = activeIdRef.current ?? id();
    if (controllers.current.has(sessionId)) return;
    const user: Message = {
      id: id(),
      role: "user",
      text: text.trim(),
      status: "complete",
      ...(images.length ? { images: images.slice(0, 4) } : {}),
    };
    const assistant: Message = {
      id: id(),
      role: "assistant",
      text: "",
      status: "streaming",
    };
    const previous = current.sessions.find((s) => s.id === sessionId);
    const stored = previous?.messages ?? [];
    const history = retryLast
      ? stored.slice(0, -1).slice(-199)
      : [...stored.slice(-198), user];
    const next = {
      ...previous,
      id: sessionId,
      title: previous?.title ?? (text.trim() || "图片对话").slice(0, 28),
      updatedAt: Date.now(),
      messages: [...history, assistant],
    };
    setState((s) => ({
      ...s,
      sessions: [
        next,
        ...s.sessions.filter((item) => item.id !== sessionId),
      ].slice(0, 100),
    }));
    setActiveId(sessionId);
    activeIdRef.current = sessionId;
    setDrafts((values) => ({ ...values, [draftKey]: "" }));
    const abort = new AbortController();
    controllers.current.set(sessionId, abort);
    setRunningIds([...controllers.current.keys()]);
    let accumulated = "";
    try {
      for await (const chunk of streamDemo(
        [
          ...(context
            ? [
                {
                  id: "flow-context",
                  role: "user" as const,
                  status: "complete" as const,
                  text: context.slice(0, 12000),
                },
              ]
            : []),
          ...chatHistory(history.filter((m) => m.status !== "error")),
        ].map(({ role, text }) => ({ role, text })),
        { signal: abort.signal },
      )) {
        accumulated += chunk;
        updateMessage(sessionId, assistant.id, { text: accumulated });
      }
      updateMessage(sessionId, assistant.id, { status: "complete" });
    } catch (error) {
      if (abort.signal.aborted)
        updateMessage(sessionId, assistant.id, {
          text: accumulated,
          status: "stopped",
        });
      else
        updateMessage(sessionId, assistant.id, {
          text:
            error instanceof Error ? error.message : "暂时无法回复，请重试。",
          status: "error",
        });
    } finally {
      controllers.current.delete(sessionId);
      setRunningIds([...controllers.current.keys()]);
    }
  }
  return {
    state,
    setState,
    ready,
    saveError,
    active,
    busy:
      (activeId !== null && allRunningIds.includes(activeId)) ||
      Boolean(
        active?.messages.some(
          (message) =>
            message.workflowRunId && isWorkflowOpen(message.workflowPhase),
        ),
      ),
    runningIds: allRunningIds,
    workflows,
    /** Runs a Flow inside the active ordinary chat, creating one if needed. */
    startChatWorkflow: async (
      flow: FlowCatalogEntry,
      input: JsonValue,
      mode: FlowMode,
    ) => {
      const current = stateRef.current.sessions.find(
        (session) => session.id === activeIdRef.current,
      );
      if (current?.workflow) return;
      const seed: Session = current ?? {
        id: id(),
        title: flow.title,
        updatedAt: Date.now(),
        messages: [],
      };
      activeIdRef.current = seed.id;
      setActiveId(seed.id);
      return workflows.start(seed.id, input, mode, flow, seed);
    },
    newWorkflowChat: (flow: FlowCatalogEntry, endpoint: string) => {
      const sessionId = id();
      const session = {
        id: sessionId,
        title: flow.title,
        updatedAt: Date.now(),
        messages: [],
        workflow: {
          id: flow.id,
          title: flow.title,
          endpoint,
          inputSchema: flow.inputSchema,
        },
      };
      setState((current) => ({
        ...current,
        sessions: [session, ...current.sessions].slice(0, 100),
      }));
      activeIdRef.current = sessionId;
      setActiveId(sessionId);
      return sessionId;
    },
    draft: drafts[activeId ?? "new"] ?? "",
    setDraft: (value: string) => {
      const key = activeIdRef.current ?? "new";
      setDrafts((current) => ({ ...current, [key]: value }));
    },
    send,
    retry: (context?: string) => {
      const messages = active?.messages ?? [];
      if (
        messages.at(-1)?.status === "error" &&
        messages.at(-2)?.role === "user"
      )
        void send(
          messages.at(-2)!.text,
          true,
          context,
          messages.at(-2)!.images,
        );
    },
    stop: () => {
      if (activeId) controllers.current.get(activeId)?.abort();
    },
    newChat: () => {
      activeIdRef.current = null;
      setActiveId(null);
    },
    openChat: (value: string) => {
      activeIdRef.current = value;
      setActiveId(value);
    },
    renameChat: (sessionId: string, title: string) => {
      const name = title.trim().replace(/\s+/gu, " ").slice(0, 100);
      if (!name) return;
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) =>
          session.id === sessionId ? { ...session, title: name } : session,
        ),
      }));
    },
    archiveChat: (sessionId: string, archived = true) => {
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) => {
          if (session.id !== sessionId) return session;
          if (archived) return { ...session, archivedAt: Date.now() };
          const { archivedAt: _archivedAt, ...rest } = session;
          return rest;
        }),
      }));
    },
    stopSession: (sessionId: string) => {
      controllers.current.get(sessionId)?.abort();
      void workflows.cancel(sessionId);
    },
    removeChat: (value: string) => {
      const removing = stateRef.current.sessions.find(
        (session) => session.id === value,
      );
      if (
        !allRunningIds.includes(value) &&
        !workflows.hasOpenRun(value) &&
        !removing?.workflow?.pending &&
        !removing?.pendingWorkflow
      ) {
        if (value === activeId) {
          activeIdRef.current = null;
          setActiveId(null);
        }
        setDrafts((current) => {
          const next = { ...current };
          delete next[value];
          return next;
        });
        setState((s) => ({
          ...s,
          hiddenWorkflowRuns: [
            ...(s.hiddenWorkflowRuns ?? []),
            ...s.sessions
              .filter((session) => session.id === value)
              .flatMap((session) =>
                session.messages.flatMap((message) => {
                  const source = messageEndpoint(session, message);
                  return message.workflowRunId && source
                    ? [workflowRunKey(source, message.workflowRunId)]
                    : [];
                }),
              ),
          ].slice(-500),
          sessions: s.sessions.filter((item) => item.id !== value),
        }));
      }
    },
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;
