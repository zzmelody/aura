import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-subagent";
import type { CodingSubagent } from "@aura/protocol/types";
import { agentFailure } from "@aura/dsh-auth/agent-failure";
import { messageText } from "./activity.ts";

/** Native catalog and durable logs, without resuming or re-submitting any child. */
export async function codingSubagents(
  ctx: Context,
  parentId: string,
): Promise<CodingSubagent[]> {
  const children = await ctx.subagents.listChildren(SessionId(parentId));
  return Promise.all(
    children.map(async (child) => {
      try {
        const inspection = await ctx.sessionController.inspect(child.id);
        // Forked history may contain the parent's turns and descriptors. Only
        // the suffix after the child's latest descriptor belongs to this task.
        const descriptor = inspection.events.findLastIndex(
          (event) => event.type === "subagent/descriptor",
        );
        const events = inspection.events.slice(descriptor + 1);
        const start = events.findLast((event) => event.type === "turn/start");
        const turn = start?.type === "turn/start" ? start.data.turn : undefined;
        const end = events.findLast(
          (event) => event.type === "turn/end" && event.data.turn === turn,
        );
        const answer = events.findLast(
          (event) =>
            event.type === "assistant/message" &&
            event.data.turn === turn &&
            !event.data.interrupted,
        );
        const live = ctx.agents.get(child.id);
        let durationMs = 0;
        let active: { turn: number; time: number } | undefined;
        for (const event of events) {
          if (event.type === "turn/start")
            active = { turn: event.data.turn, time: event.time };
          else if (
            event.type === "turn/end" &&
            active?.turn === event.data.turn
          ) {
            durationMs += Math.max(0, event.time - active.time);
            active = undefined;
          }
        }
        if (active)
          durationMs += Math.max(
            0,
            (live?.status === "running"
              ? Date.now()
              : (events.at(-1)?.time ?? active.time)) - active.time,
          );
        const executionError =
          end?.type === "turn/end" && end.data.reason.kind === "error"
            ? agentFailure(end.data.reason.error.message).message
            : end?.type === "turn/end" && end.data.reason.kind === "max-tokens"
              ? "子 Agent 达到输出上限，任务未完成。"
              : undefined;
        return {
          id: child.id,
          label: child.label ?? "子 Agent",
          role: inspection.meta.agentPreset?.includes("reviewer")
            ? "只读审查"
            : "只读调研",
          status:
            live?.status === "running"
              ? "running"
              : end?.type === "turn/end" && end.data.reason.kind === "completed"
                ? "complete"
                : executionError
                  ? "error"
                  : start
                    ? "stopped"
                    : "unknown",
          result:
            answer?.type === "assistant/message"
              ? messageText(answer.data.message.content).slice(0, 12_000)
              : "",
          ...(start ? { durationMs } : {}),
          ...(executionError ? { executionError } : {}),
        };
      } catch {
        return {
          id: child.id,
          label: child.label ?? "子 Agent",
          role: "子 Agent",
          status:
            ctx.agents.get(child.id)?.status === "running"
              ? "running"
              : "unknown",
          result: "",
          recordError: "暂时无法读取子 Agent 记录，执行结果尚无法确认。",
        };
      }
    }),
  );
}
