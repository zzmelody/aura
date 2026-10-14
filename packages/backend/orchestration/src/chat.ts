import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller";
import { resolveChatModel } from "./chat-models.ts";
import { chatTools, type ChatToolHost } from "./chat-tools.ts";
import { agentFailure } from "./sessions.ts";
import type { GeneratedArtifacts } from "./artifacts/generated.ts";
import { CHAT_IMAGE_LIMIT } from "@aura/protocol/types";

import type { ChatStreamEvent, ChatTurn } from "./types.ts";

export type { ChatStreamEvent, ChatTurn } from "./types.ts";

const historyPrefix = "AURA_HISTORY_V1\n";

type ImagePart = {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  name: string;
};

/**
 * The newest images go to the model, up to the request limit; every message
 * keeps a text marker so the model knows which turn each picture belongs to.
 * Demo mode cannot see images and only receives the marker.
 */
export async function chatImages(
  turn: ChatTurn,
  store: Pick<GeneratedArtifacts, "readImage">,
  signal: AbortSignal,
) {
  const chosen = new Set<string>();
  if (turn.mode !== "demo")
    for (const message of [...turn.messages].reverse())
      for (const id of [...(message.images ?? [])].reverse())
        if (chosen.size < CHAT_IMAGE_LIMIT) chosen.add(id);
  const labels = new Map<string, string>();
  for (const message of turn.messages)
    for (const id of message.images ?? [])
      if (chosen.has(id) && !labels.has(id))
        labels.set(id, `图${labels.size + 1}`);
  const parts: ImagePart[] = [];
  for (const [id, label] of labels) {
    const image = await store.readImage(id, signal);
    parts.push({
      type: "image",
      mediaType: image.mediaType,
      data: image.bytes.toString("base64"),
      name: label,
    });
  }
  const history = turn.messages.map(({ role, text, images }) => {
    if (!images?.length) return { role, text };
    const note =
      turn.mode !== "demo"
        ? `[用户附图：${images.map((id) => labels.get(id) ?? "较早的图片，未随本次请求附带").join("、")}]`
        : `[用户附了 ${images.length} 张图片；演示模型无法查看图片内容]`;
    return { role, text: text ? `${text}\n${note}` : note };
  });
  return { history, parts };
}

/**
 * One short-lived DSH session per chat request. The Agent sees no DSH, preset
 * or profile tools; only Aura's chat workflow tools are mounted in its scope.
 */
export function chatService(
  ctx: Context,
  host: ChatToolHost,
  images: Pick<GeneratedArtifacts, "readImage">,
) {
  const controller = ctx.sessionController;
  return async function stream(
    turn: ChatTurn,
    emit: (event: ChatStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }> {
    const stop = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const config = await resolveChatModel(
      ctx.llm,
      turn.mode,
      {
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.reasoningEffort
          ? { reasoningEffort: turn.reasoningEffort }
          : {}),
      },
      stop,
      turn.defaults,
    );
    const sessionId = SessionId(randomUUID());
    const preset = (await ctx.agentPresets.resolve("chat-v1")).id;
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: config.provider, model: config.model },
      // Ordinary chats belong to no workspace; they run in the built-in one.
      meta: {
        agentPreset: preset,
        cwd: process.env.AURA_DEFAULT_WORKSPACE ?? process.env.AURA_FLOW_CWD,
      },
      signal: stop,
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset);
      },
    });
    const agent = handle.agent;
    const scoped: Array<() => void> = [];
    const disposers: Array<() => void> = [];
    try {
      scoped.push(agent.ctx.tools.presentAs("native"));
      scoped.push(agent.ctx.tools.restrict({ allow: [] }));
      for (const tool of chatTools(host, {
        mode: turn.mode,
        signal: stop,
        started: (run) => emit({ type: "workflow", ...run }),
      }))
        scoped.push(agent.ctx.tools.register(tool));
      scoped.push(
        agent.ctx.on("agent/request", async (_payload, next) => {
          await next();
          return {
            provider: config.provider,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            ...(config.maxTokens === undefined
              ? {}
              : { maxTokens: config.maxTokens }),
          };
        }),
      );
      // The controller reads this pending selection on first prompt admission.
      // Do not call selectModel: it would also save a deployment-wide default.
      agent.session.append("model/selection", {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
      });
      const requestId = randomUUID() as SessionRequestId;
      let turnNumber: number | undefined;
      // A tool loop yields one assistant message per model step; keep them apart.
      let wroteText = false;
      let matched: number | undefined;
      let finish!: { resolve(): void; reject(reason: unknown): void };
      const completed = new Promise<void>((resolve, reject) => {
        finish = { resolve, reject };
      });
      completed.catch(() => {});
      disposers.push(
        ctx.on("session/event", (session, event) => {
          if (session.id !== sessionId) return;
          if (event.type === "turn/start") turnNumber = event.data.turn;
          if (
            event.type === "user/message" &&
            "rpcId" in event.data.source &&
            event.data.source.rpcId === requestId
          )
            matched = turnNumber;
          if (matched === undefined) return;
          if (
            event.type === "assistant/message" &&
            event.data.turn === matched &&
            !event.data.interrupted
          ) {
            const text = event.data.message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
            if (text) {
              emit({ type: "delta", text: wroteText ? `\n\n${text}` : text });
              wroteText = true;
            }
          }
          if (event.type === "turn/end" && event.data.turn === matched) {
            if (event.data.reason.kind === "completed") finish.resolve();
            else
              finish.reject(
                agentFailure(
                  event.data.reason.kind === "error"
                    ? event.data.reason.error.message
                    : undefined,
                ),
              );
          }
        }),
      );
      disposers.push(
        ctx.on("api-session/error", (id, message) => {
          if (id === sessionId) finish.reject(agentFailure(message));
        }),
      );
      const onAbort = () => {
        controller.cancel({ sessionId });
        finish.reject(stop.reason);
      };
      stop.addEventListener("abort", onAbort, { once: true });
      try {
        stop.throwIfAborted();
        const attached = await chatImages(turn, images, stop);
        await controller.prompt(
          {
            sessionId,
            requestId,
            mode: "queue",
            content: [
              {
                type: "text",
                text: `${historyPrefix}${JSON.stringify({ messages: attached.history })}`,
              },
              ...attached.parts,
            ],
          },
          stop,
        );
        await completed;
        await ctx.agents.get(sessionId)?.whenIdle();
      } finally {
        stop.removeEventListener("abort", onAbort);
        if (stop.aborted) controller.cancel({ sessionId });
      }
      return { model: config.model };
    } finally {
      for (const dispose of disposers) dispose();
      for (const dispose of scoped.reverse()) dispose();
      const session = ctx.sessions.get(sessionId);
      if (session) await ctx.sessions.flush(session).catch(() => false);
      await handle.dispose();
    }
  };
}
