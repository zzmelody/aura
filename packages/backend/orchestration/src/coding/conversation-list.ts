import type { CodingConversationInfo } from "@aura/protocol/types";

/** Startup lists do not need to open every stored session log. */
export async function conversationList(
  conversations: CodingConversationInfo[],
  options: {
    includeStatus: boolean;
    running(id: string): boolean;
    waitingForAnswer(id: string): boolean;
    readStatus(id: string): Promise<CodingConversationInfo["lastTurnStatus"]>;
  },
): Promise<CodingConversationInfo[]> {
  return Promise.all(
    conversations.map(async (conversation) => {
      if (options.running(conversation.id))
        return {
          ...conversation,
          lastTurnStatus: "running" as const,
          ...(options.waitingForAnswer(conversation.id)
            ? { waitingForAnswer: true as const }
            : {}),
        };
      if (!options.includeStatus) return conversation;
      const stored = await options
        .readStatus(conversation.id)
        .catch(() => undefined);
      return stored === undefined
        ? conversation
        : {
            ...conversation,
            lastTurnStatus: stored === "running" ? "stopped" : stored,
          };
    }),
  );
}
