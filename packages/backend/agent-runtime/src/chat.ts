import { randomUUID } from "node:crypto";
import { CodedFlowError } from "@aura/protocol/errors";
import type { ChatStreamEvent, ChatTurn } from "./types.ts";
import type { conversationService } from "./conversations/conversations.ts";

export type { ChatStreamEvent, ChatTurn } from "./types.ts";
export { chatImages } from "./chat-images.ts";

/** Legacy HTTP/RPC shape; all execution uses the persistent conversation driver. */
export function chatService(service: ReturnType<typeof conversationService>) {
  return async (
    turn: ChatTurn,
    emit: (event: ChatStreamEvent) => void,
    signal: AbortSignal,
  ) => {
    const message = turn.messages.at(-1);
    if (!message || message.role !== "user")
      throw new CodedFlowError("对话请求需要以用户消息结束。", 400, {
        code: "conversation_last_user_required",
      });
    return service.stream(
      {
        sessionId: turn.sessionId ?? `chat-${randomUUID()}`,
        prompt: message.text,
        history: turn.messages.slice(0, -1),
        images: message.images,
        mode: turn.mode,
        model: turn.model,
        reasoningEffort: turn.reasoningEffort,
        defaults: turn.defaults,
      },
      (event) => {
        if (event.type === "delta" || event.type === "workflow") emit(event);
      },
      signal,
    );
  };
}
