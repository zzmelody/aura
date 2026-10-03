import type { ChatModelSelection, ChatRequest, ChatWorkflowStart } from "@aura/protocol/types";
import { streamDemo } from "@aura/demo";
import type { Message } from "@aura/core/types";
import type { Workspace } from "@aura/core/types";

/** Streamed reply text, or a workflow the chat model started as a tool. */
export type ReplyChunk = string | ({ type: "workflow" } & ChatWorkflowStart);

export async function* reply(
  messages: Message[],
  provider: Workspace["provider"],
  endpoint: string,
  sessionId: string,
  signal: AbortSignal,
  modelConfig?: ChatModelSelection,
): AsyncGenerator<ReplyChunk> {
  if (provider === "offline") {
    yield* streamDemo(
      messages.map(({ role, text }) => ({ role, text })),
      { signal },
    );
    return;
  }
  const response = await fetch(`${endpoint}${provider === "codex" ? "/chat/codex" : "/chat"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ...(modelConfig ? { modelConfig } : {}),
      messages: messages.map(({ role, text, images }) => ({
        role,
        text,
        ...(role === "user" && images?.length
          ? { images: images.map((image) => image.assetId) }
          : {}),
      })),
    } satisfies ChatRequest),
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error(`工作台连接失败（${response.status}）。请检查服务地址。`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "delta" && typeof event.text === "string")
          yield event.text;
        if (
          event.type === "workflow" &&
          typeof event.runId === "string" &&
          typeof event.flowId === "string" &&
          typeof event.title === "string"
        )
          yield {
            type: "workflow",
            flowId: event.flowId,
            title: event.title,
            runId: event.runId,
            inputPreview:
              typeof event.inputPreview === "string" ? event.inputPreview : "",
          };
        if (event.type === "error")
          throw new Error(event.message || "对话服务暂时不可用");
        if (event.type === "done") completed = true;
      }
    }
    if (!completed) throw new Error("连接已中断，可以重新发送这条消息。");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
