import { useEffect, useRef, useState } from "react";
import { initialState, restoreState, STORAGE_KEY } from "@aura/core";
import { reply } from "./transport";
import type { Message, Workspace } from "@aura/core/types";

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
  useEffect(() => {
    let mounted = true;
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
      for (const controller of controllers.current.values()) controller.abort();
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
  async function send(text: string, retryLast = false, context?: string) {
    if (!text.trim() || text.length > 4000) return;
    const current = stateRef.current;
    const draftKey = activeIdRef.current ?? "new";
    const sessionId = activeIdRef.current ?? id();
    if (controllers.current.has(sessionId)) return;
    const user: Message = {
      id: id(),
      role: "user",
      text: text.trim(),
      status: "complete",
    };
    const assistant: Message = {
      id: id(),
      role: "assistant",
      text: "",
      status: "streaming",
    };
    const stored =
      current.sessions.find((s) => s.id === sessionId)?.messages ?? [];
    const history = retryLast
      ? stored.slice(0, -1).slice(-199)
      : [...stored.slice(-198), user];
    const next = {
      id: sessionId,
      title:
        current.sessions.find((s) => s.id === sessionId)?.title ??
        text.trim().slice(0, 28),
      updatedAt: Date.now(),
      messages: [...history, assistant],
    };
    setState((s) => ({
      ...s,
      sessions: [
        next,
        ...s.sessions.filter((item) => item.id !== sessionId),
      ].slice(0, 60),
    }));
    setActiveId(sessionId);
    activeIdRef.current = sessionId;
    setDrafts((values) => ({ ...values, [draftKey]: "" }));
    const abort = new AbortController();
    controllers.current.set(sessionId, abort);
    setRunningIds([...controllers.current.keys()]);
    let accumulated = "";
    try {
      for await (const chunk of reply(
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
          ...history.filter((m) => m.status !== "error"),
        ],
        current.provider,
        current.endpoint,
        sessionId,
        abort.signal,
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
    busy: activeId !== null && runningIds.includes(activeId),
    runningIds,
    draft: drafts[activeId ?? "new"] ?? "",
    setDraft: (value: string) =>
      setDrafts((current) => ({ ...current, [activeId ?? "new"]: value })),
    send,
    retry: (context?: string) => {
      const messages = active?.messages ?? [];
      if (
        messages.at(-1)?.status === "error" &&
        messages.at(-2)?.role === "user"
      )
        void send(messages.at(-2)!.text, true, context);
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
    removeChat: (value: string) => {
      if (!controllers.current.has(value)) {
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
          sessions: s.sessions.filter((item) => item.id !== value),
        }));
      }
    },
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;
