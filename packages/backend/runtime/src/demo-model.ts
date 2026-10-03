import { streamDemo } from "@aura/demo";
import { flowDemoReply } from "@aura/orchestration/demo";
import { validateMessages } from "@aura/protocol";
import type { ChatMessage } from "@aura/protocol/types";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
  closeHonoServer,
  errorMessage,
  formatHttpUrl,
  startHonoServer,
} from "./http-server.ts";
import type { DemoModelHandle } from "./types.ts";
import { isRecord } from "./validation.ts";
import {
  demoToolCall,
  demoToolReply,
  hasToolResult,
  type DemoToolCall,
} from "./demo-chat-tools.ts";

const historyMarker = "AURA_HISTORY_V1\n";

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (
      !isRecord(part) ||
      part.type !== "text" ||
      typeof part.text !== "string"
    )
      continue;
    parts.push(part.text);
  }
  return parts.join("");
}

function extractHistory(request: unknown): ChatMessage[] {
  if (!isRecord(request) || !Array.isArray(request.messages))
    throw new Error("Missing model messages.");

  let payload: string | undefined;
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = contentText(message.content);
    if (text?.startsWith(historyMarker)) {
      payload = text.slice(historyMarker.length);
      break;
    }
  }
  if (!payload) throw new Error("Missing Aura history payload.");

  const parsed = JSON.parse(payload) as unknown;
  if (!isRecord(parsed) || !validateMessages(parsed.messages))
    throw new Error("Invalid Aura history payload.");
  return parsed.messages;
}

/** Builds the private OpenAI-compatible Hono app used by the DSH demo route. */
export function createDemoModelApp() {
  const app = new Hono();
  app.post(
    "/v1/chat/completions",
    bodyLimit({
      maxSize: 256 * 1_024,
      onError: (context) => context.body(null, 413),
    }),
    async (context) => {
      let body: unknown;
      let flowOutput: string | undefined;
      let messages: ChatMessage[];
      let toolCall: DemoToolCall | undefined;
      try {
        body = (await context.req.json()) as unknown;
        flowOutput = flowDemoReply(isRecord(body) ? body.messages : undefined);
        messages = flowOutput === undefined ? extractHistory(body) : [];
        if (flowOutput === undefined) {
          toolCall = demoToolCall(body, messages);
          if (!toolCall && hasToolResult(body)) flowOutput = demoToolReply(body);
        }
      } catch (error) {
        console.error("[Aura demo model]", errorMessage(error));
        return context.body(null, 400);
      }

      return streamSSE(context, async (output) => {
        if (toolCall) {
          await output.writeSSE({
            data: JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                        type: "function",
                        function: {
                          name: toolCall.name,
                          arguments: JSON.stringify(toolCall.arguments),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          });
          await output.writeSSE({
            data: JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            }),
          });
          await output.writeSSE({ data: "[DONE]" });
          return;
        }
        const disconnected = new AbortController();
        output.onAbort(() => disconnected.abort());
        const chunks =
          flowOutput === undefined
            ? streamDemo(messages, {
                signal: disconnected.signal,
                delay: 8,
              })
            : [flowOutput];
        for await (const text of chunks) {
          if (output.aborted) break;
          await output.writeSSE({
            data: JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                },
              ],
            }),
          });
        }
        if (output.aborted) return;
        await output.writeSSE({
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await output.writeSSE({ data: "[DONE]" });
      });
    },
  );
  app.notFound((context) => context.body(null, 404));
  return app;
}

/** Starts the isolated, loopback-only model used by the DSH demo route. */
export async function startDemoModel(): Promise<DemoModelHandle> {
  const app = createDemoModelApp();
  const { server, port } = await startHonoServer(app, "127.0.0.1", 0);
  return {
    url: `${formatHttpUrl("127.0.0.1", port)}/v1`,
    close: () => closeHonoServer(server),
  };
}
