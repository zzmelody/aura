import type { CodexTokenSource } from "@aura/dsh-auth";
import { ActionFailure } from "./action-api.ts";
/** Bytes plus what Codex reported; one call is one image tool use. */
export interface CodexImageResponse {
  bytes: Uint8Array;
  revisedPrompt?: string;
}

/** Narrow request port so tests never touch the network or real tokens. */
export type CodexImageRequest = (
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Response>;

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MAX_STREAM_BYTES = 48 * 1024 * 1024;

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Sends one Responses request with the image_generation tool through the
 * signed-in Codex subscription; the token comes from the shared DSH login.
 */
export function codexImageRequest(
  tokens: CodexTokenSource,
  model: string,
): CodexImageRequest {
  return async (body, signal) => {
    const access = await tokens.token(signal);
    if (!access)
      throw new ActionFailure(
        "codex_image_signed_out: 请先在右上角登录 Codex。",
      );
    return fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${access.token}`,
        "chatgpt-account-id": access.accountId,
        originator: "pi",
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, store: false, stream: true, ...body }),
    });
  };
}

/** Reads a bounded SSE body and returns the finished image tool call. */
export async function readCodexImageStream(
  response: Response,
): Promise<CodexImageResponse> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ActionFailure("codex_image_failed: Codex 没有返回内容。");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_STREAM_BYTES)
        throw new ActionFailure("codex_image_failed: Codex 返回内容超过上限。");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  let image: CodexImageResponse | undefined;
  let failure: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = eventRecord(JSON.parse(line.slice(6)) as unknown);
    } catch {
      continue;
    }
    if (!event) continue;
    const item = eventRecord(event.item);
    if (
      event.type === "response.output_item.done" &&
      item?.type === "image_generation_call" &&
      typeof item.result === "string"
    )
      image = {
        bytes: Buffer.from(item.result, "base64"),
        ...(typeof item.revised_prompt === "string"
          ? { revisedPrompt: item.revised_prompt.slice(0, 2000) }
          : {}),
      };
    if (event.type === "error" || event.type === "response.failed") {
      const message =
        eventRecord(event.error)?.message ??
        eventRecord(eventRecord(event.response)?.error)?.message ??
        event.message;
      failure =
        typeof message === "string" ? message.slice(0, 300) : "未知错误";
    }
  }
  if (image) return image;
  throw new ActionFailure(
    failure
      ? `codex_image_failed: Codex 图片生成失败：${failure}`
      : "codex_image_failed: Codex 没有生成图片，请换个描述再试。",
  );
}
