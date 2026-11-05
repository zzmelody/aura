import { conversationSides } from "@aura/protocol/conversations";
import type { CodingConversationInfo } from "@aura/protocol/types";

/**
 * Startup lists do not need to open every stored session log. A conversation
 * counts as running while its main session or any of its side chats runs.
 */
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
      const active = [
        conversation.id,
        ...(conversation.archivedAt === undefined
          ? conversationSides(conversation).map((side) => side.id)
          : []),
      ].filter((id) => options.running(id));
      if (active.length)
        return {
          ...conversation,
          lastTurnStatus: "running" as const,
          ...(active.some((id) => options.waitingForAnswer(id))
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
