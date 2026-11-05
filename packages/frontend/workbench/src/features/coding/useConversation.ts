import { useCallback, useSyncExternalStore } from "react";
import { conversations, type ConversationView } from "./conversation-store.ts";

const empty: ConversationView = { connection: "offline" };

export function useConversation(endpoint: string, sessionId?: string) {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId
        ? conversations.subscribe(endpoint, sessionId, listener)
        : () => undefined,
    [endpoint, sessionId],
  );
  const snapshot = useCallback(
    () => (sessionId ? conversations.view(endpoint, sessionId) : empty),
    [endpoint, sessionId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
