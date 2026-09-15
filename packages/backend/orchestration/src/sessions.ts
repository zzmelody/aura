import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {
  SessionRequestId,
  SessionPage,
} from "@deepseek-ai/dsh-api-session-controller";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import type { FlowHistory } from "@aura/protocol/types";
import type { SessionPort } from "./types.ts";
import { FlowError } from "./schema.ts";
import type { ActionRuntime } from "./actions.ts";

const plainText = (content?: readonly ContentBlock[]) =>
  (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

function agentFailure(message?: string): FlowError {
  const status = message?.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  return new FlowError(
    status
      ? `DSH 模型请求失败（HTTP ${status}），请查看对应会话。`
      : "DSH Agent 执行失败，请查看对应会话。",
  );
}

/** Narrow public DSH Session Controller adapter; no parallel session engine. */
export function dshSessions(ctx: Context, actions: ActionRuntime): SessionPort {
  const controller = ctx.sessionController;
  return {
    async execute({
      sessionId: rawId,
      preset,
      input,
      mode,
      timeoutMs,
      signal,
      runId,
      id: localId,
      stepKey,
      actionDefinitions,
      requestId: savedRequestId,
    }) {
      const sessionId = SessionId(rawId);
      const timeout = AbortSignal.timeout(timeoutMs);
      const stop = AbortSignal.any([signal, timeout]);
      stop.throwIfAborted();
      await controller.create({
        sessionId,
        agentPreset: preset,
        cwd: process.env.AURA_FLOW_CWD,
      });
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw new FlowError("DSH Agent 创建后不可用。");
      const unmountActions = actions.mount(agent, actionDefinitions, {
        cwd: process.env.AURA_FLOW_CWD ?? process.cwd(),
        mode,
        runId,
        stepId: stepKey ?? localId,
        sessionId: rawId,
      });
      try {
        await controller.selectModel({
          sessionId,
          provider: mode === "codex" ? "openai-codex" : "deepseek-official",
          model:
            mode === "codex"
              ? process.env.AURA_CODEX_MODEL || "gpt-5.6-terra"
              : "deepseek-v4-flash",
          reasoningEffort: mode === "codex" ? "medium" : "off",
        });
        if (!savedRequestId)
          throw new FlowError("Agent attempt 缺少持久化 requestId。");
        const requestId = savedRequestId as SessionRequestId;
        let matchedTurn: number | undefined;
        let turn: number | undefined;
        const disposers: (() => void)[] = [];
        let finish!: { resolve(): void; reject(reason: unknown): void };
        const completed = new Promise<void>((resolve, reject) => {
          finish = { resolve, reject };
        });
        completed.catch(() => {});
        disposers.push(
          ctx.on("session/event", (session, event) => {
            if (session.id !== sessionId) return;
            if (event.type === "turn/start") turn = event.data.turn;
            if (
              event.type === "user/message" &&
              "rpcId" in event.data.source &&
              event.data.source.rpcId === requestId
            )
              matchedTurn = turn;
            if (
              event.type === "turn/end" &&
              matchedTurn !== undefined &&
              event.data.turn === matchedTurn
            ) {
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
          await controller.prompt(
            {
              sessionId,
              requestId,
              mode: "queue",
              content: [{ type: "text", text: input }],
            },
            stop,
          );
          await completed;
          await ctx.agents.get(sessionId)?.whenIdle();
          stop.throwIfAborted();
          const session = ctx.sessions.get(sessionId);
          if (!session || !(await ctx.sessions.flush(session)))
            throw new Error("Session was not persisted");
          const messages = session.deriveMessages();
          return plainText(
            messages.findLast((message) => message.role === "assistant")
              ?.content,
          );
        } finally {
          stop.removeEventListener("abort", onAbort);
          for (const dispose of disposers) dispose();
          if (stop.aborted) {
            controller.cancel({ sessionId });
            await ctx.agents.get(sessionId)?.whenIdle();
          }
          const session = ctx.sessions.get(sessionId);
          if (session) await ctx.sessions.flush(session);
        }
      } finally {
        unmountActions();
      }
    },
    async reconcile(step) {
      if (!step.requestId)
        throw new FlowError("Agent attempt 缺少持久化 requestId。");
      let inspection;
      try {
        inspection = await controller.inspect(
          SessionId(step.sessionId),
          AbortSignal.timeout(15_000),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "SessionPersistenceNotFoundError"
        )
          return { actionStarted: false };
        throw error;
      }
      let turn: number | undefined;
      let matched: number | undefined;
      let output: string | undefined;
      let completed = false;
      let actionStarted = false;
      for (const event of inspection.events) {
        if (event.type === "turn/start") turn = event.data.turn;
        if (
          event.type === "user/message" &&
          "rpcId" in event.data.source &&
          event.data.source.rpcId === step.requestId
        )
          matched = turn;
        if (matched === undefined) continue;
        if (event.type === "tool/call" && event.data.turn === matched)
          actionStarted = true;
        if (
          event.type === "assistant/message" &&
          event.data.turn === matched &&
          !event.data.interrupted
        )
          output = plainText(event.data.message.content);
        if (event.type === "turn/end" && event.data.turn === matched)
          completed = event.data.reason.kind === "completed";
      }
      return {
        actionStarted,
        ...(completed && output?.trim() && output.length <= 80_000
          ? { output }
          : {}),
      };
    },
    async history(step, beforeSeq) {
      if (
        beforeSeq !== undefined &&
        (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)
      )
        throw new FlowError("无效的历史游标。");
      if (!step.startedAt)
        return {
          sessionId: step.sessionId,
          preset: step.preset,
          entries: [],
          hasMore: false,
        };
      const address = {
        kind: "session" as const,
        sessionId: SessionId(step.sessionId),
      };
      // Use DSH's message-aligned paging, including cold reads after host restart.
      let page: SessionPage;
      if (beforeSeq !== undefined) {
        page = await controller.page(
          { address, throughSeq: beforeSeq - 1, beforeSeq, maxMessages: 30 },
          AbortSignal.timeout(15000),
        );
      } else {
        const abort = new AbortController();
        const stream = controller
          .follow({ address, maxMessages: 30 }, abort.signal)
          [Symbol.asyncIterator]();
        try {
          const first = await stream.next();
          if (first.done || first.value.type !== "snapshot")
            throw new Error("Missing session snapshot");
          page = first.value;
        } finally {
          abort.abort();
          await stream.return?.();
        }
      }
      const entries: FlowHistory["entries"] = [];
      const seqs: number[] = [];
      for (const record of page.records) {
        const event = record.event;
        seqs.push(event.seq);
        // Deliberately project visible content only: never raw request headers,
        // plugin metadata, reasoning, credential references or provider errors.
        if (record.type !== "event") continue;
        // DSH's wire DTO intentionally erases event-specific data types.
        const data = event.data as {
          content?: ContentBlock[];
          message?: { content: ContentBlock[] };
          name?: string;
          reason?: { kind: string; error?: { message?: string } };
        };
        if (event.type === "user/message")
          entries.push({
            seq: event.seq,
            kind: "user",
            text: plainText(data.content),
          });
        if (event.type === "assistant/message")
          entries.push({
            seq: event.seq,
            kind: "assistant",
            text: plainText(data.message?.content),
          });
        if (event.type === "tool/call")
          entries.push({
            seq: event.seq,
            kind: "tool",
            text: `调用工具：${data.name}`,
          });
        if (event.type === "tool/result")
          entries.push({
            seq: event.seq,
            kind: "tool",
            text: "工具执行结束（完整结果保留在 DSH 会话日志）。",
          });
        if (event.type === "turn/end") {
          const status =
            data.reason?.error?.message?.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
          entries.push({
            seq: event.seq,
            kind: "event",
            text: `回合结束：${data.reason?.kind}${
              status ? `（模型请求失败，HTTP ${status}）` : ""
            }`,
          });
        }
      }
      return {
        sessionId: step.sessionId,
        preset: step.preset,
        entries,
        hasMore: page.hasMore,
        ...(seqs.length ? { beforeSeq: Math.min(...seqs) } : {}),
      };
    },
  };
}
