import { createServer } from "node:http";
import { streamDemo } from "@aura/demo";
import { flowDemoReply } from "@aura/orchestration/demo";
import { validateMessages } from "@aura/protocol";
import type { ChatMessage } from "@aura/protocol/types";
import {
  closeHttpServer,
  errorMessage,
  formatHttpUrl,
  listenHttpServer,
} from "./http-server.ts";
import type { DemoModelHandle } from "./types.ts";
import { isRecord, readJson } from "./validation.ts";

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

/** Starts the isolated, loopback-only model used by the DSH demo route. */
export async function startDemoModel(): Promise<DemoModelHandle> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (
          request.method !== "POST" ||
          request.url !== "/v1/chat/completions"
        ) {
          response.writeHead(404).end();
          return;
        }
        const body = await readJson(request);
        const flowOutput = flowDemoReply(
          isRecord(body) ? body.messages : undefined,
        );
        const messages = flowOutput === undefined ? extractHistory(body) : [];
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        const abort = new AbortController();
        response.on("close", () => abort.abort());
        const stream =
          flowOutput === undefined
            ? streamDemo(messages, {
                signal: abort.signal,
                delay: 8,
              })
            : [flowOutput];
        for await (const text of stream) {
          response.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
          );
        }
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      } catch (error) {
        if (!response.destroyed)
          console.error("[Aura demo model]", errorMessage(error));
        if (!response.headersSent) response.writeHead(400);
        if (!response.destroyed) response.end();
      }
    })();
  });

  await listenHttpServer(server, "127.0.0.1", 0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("Aura demo model did not expose a TCP port.");
  }

  return {
    url: `${formatHttpUrl("127.0.0.1", address.port)}/v1`,
    close: () => closeHttpServer(server),
  };
}
