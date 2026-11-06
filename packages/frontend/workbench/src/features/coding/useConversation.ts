import { useCallback, useSyncExternalStore } from "react";
import { messageText } from "@aura/i18n/runtime";
import { useConversationMessages } from "../../conversation-messages";
import { conversations, type ConversationView } from "./conversation-store.ts";

const empty: ConversationView = { connection: "offline" };

export function useConversation(endpoint: string, sessionId?: string) {
  const { i18n } = useConversationMessages();
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
  const view = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    ...view,
    error: view.error === undefined ? undefined : messageText(view.error, i18n),
  };
}
