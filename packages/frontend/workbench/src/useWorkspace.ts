import { useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  initialState,
  restoreState,
  STORAGE_KEY,
} from "@aura/core";
import { reply } from "./transport";
import type { Message, Workspace } from "@aura/core/types";

const id = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function useWorkspace() {
  const [state, setState] = useState<Workspace>(initialState() as Workspace);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (mounted && raw)
          setState(restoreState(JSON.parse(raw)) as Workspace);
      })
      .catch(() => {
        if (mounted) setSaveError("无法读取本地记录，本次会话仍可使用。");
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() =>
        setSaveError("本地存储空间不足，最新对话可能无法保存。"),
      );
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
  async function send(text: string, retryLast = false) {
    if (!text.trim() || controller.current || text.length > 4000) return;
    const current = stateRef.current;
    const sessionId = activeId ?? id();
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
    setBusy(true);
    const abort = new AbortController();
    controller.current = abort;
    let accumulated = "";
    try {
      for await (const chunk of reply(
        history.filter((m) => m.status !== "error"),
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
      controller.current = null;
      setBusy(false);
    }
  }
  return {
    state,
    setState,
    ready,
    saveError,
    active,
    busy,
    send,
    retry: () => {
      const messages = active?.messages ?? [];
      if (
        messages.at(-1)?.status === "error" &&
        messages.at(-2)?.role === "user"
      )
        void send(messages.at(-2)!.text, true);
    },
    stop: () => controller.current?.abort(),
    newChat: () => {
      if (!controller.current) setActiveId(null);
    },
    openChat: (value: string) => {
      if (!controller.current) setActiveId(value);
    },
    removeChat: (value: string) => {
      if (!controller.current) {
        if (value === activeId) setActiveId(null);
        setState((s) => ({
          ...s,
          sessions: s.sessions.filter((item) => item.id !== value),
        }));
      }
    },
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;
