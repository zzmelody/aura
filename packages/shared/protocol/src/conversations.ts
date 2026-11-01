import type {
  ChatMessage,
  CodingConversationInfo,
  CodingHistoryTurn,
  CodingSideConversationInfo,
} from "./types.ts";

/** One persistent personal-assistant main session per Aura backend storage. */
export const PERSONAL_ASSISTANT_SESSION_ID = "coding-aura-personal-assistant";

/** Reads legacy single-side metadata without migrating the stored record. */
export function conversationSides(
  conversation: Pick<
    CodingConversationInfo,
    "sideConversations" | "sideSessionId" | "sideModelConfig" | "createdAt"
  >,
): CodingSideConversationInfo[] {
  if (conversation.sideConversations) return conversation.sideConversations;
  return conversation.sideSessionId
    ? [
        {
          id: conversation.sideSessionId,
          title: "旁支对话",
          createdAt: conversation.createdAt,
          ...(conversation.sideModelConfig
            ? { modelConfig: conversation.sideModelConfig }
            : {}),
        },
      ]
    : [];
}

const contextPrefix = "AURA_CONVERSATION_CONTEXT_V1\n";

/** Context is quoted data; the current user request stays separately named. */
export function conversationPrompt(
  prompt: string,
  history: readonly ChatMessage[] = [],
  context?: string,
): string {
  return history.length || context
    ? `${contextPrefix}${JSON.stringify({ prompt, history, context })}`
    : prompt;
}

/** Replay hides the context envelope, never the user's actual request. */
export function conversationPromptText(value: string): string {
  if (!value.startsWith(contextPrefix)) return value;
  try {
    const parsed: unknown = JSON.parse(value.slice(contextPrefix.length));
    if (
      parsed &&
      typeof parsed === "object" &&
      "prompt" in parsed &&
      typeof parsed.prompt === "string"
    )
      return parsed.prompt;
  } catch {
    // A user may literally type the prefix; malformed envelopes stay literal.
  }
  return value;
}

/** Import actual legacy messages without inventing tool executions. */
export function legacyConversationTurns(
  messages: readonly ChatMessage[],
  time: number,
): CodingHistoryTurn[] {
  const turns: CodingHistoryTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({
        prompt: message.text,
        startedAt: time,
        endedAt: time,
        status: "complete",
        events: [],
      });
    } else {
      let turn = turns.at(-1);
      if (!turn) {
        turn = {
          prompt: "",
          startedAt: time,
          endedAt: time,
          status: "complete",
          events: [],
        };
        turns.push(turn);
      }
      turn.events.push({ type: "delta", text: message.text });
    }
  }
  return turns;
}
