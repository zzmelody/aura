import type { Session } from "@aura/core/types";
import type {
  ChatMessage,
  FlowCatalogEntry,
  FlowMode,
  JsonValue,
} from "@aura/protocol/types";

/** An explicit execution request stays in the conversation's durable history. */
export function flowConversationPrompt(
  flow: Pick<FlowCatalogEntry, "id" | "title">,
  input: JsonValue,
  mode: FlowMode,
): string {
  return `请运行工作流「${flow.title}」。\n工作流 ID：${flow.id}\n运行模式：${mode}\n输入：\n${JSON.stringify(input, null, 2)}`;
}

/** Old run sessions carry their original IDs and inputs into further discussion. */
export function flowConversationHistory(session: Session): ChatMessage[] {
  // The original Run remains queryable; keep this seed inside the chat body's
  // size limit even when old runs contain long reports or structured outputs.
  return session.messages.slice(-12).map((message) => {
    const excerpt =
      message.text.length > 1_000
        ? `${message.text.slice(0, 1_000)}\n（摘要已截断，完整输入与结果保留在原运行中。）`
        : message.text;
    if (!message.workflowRunId)
      return {
        role: message.role,
        text: excerpt,
        ...(message.images?.length
          ? { images: message.images.map((image) => image.assetId) }
          : {}),
      };
    return {
      role: "assistant",
      text: `工作流「${message.workflow?.title ?? session.workflow?.title ?? "工作流"}」\n运行 ID：${message.workflowRunId}\n${excerpt}\n继续讨论前可读取此运行的当前结果；不要自动重新执行。`,
    };
  });
}

export interface FlowConversationRequest {
  id: string;
  flow: FlowCatalogEntry;
}
