import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-subagent";
import type { CodingSubagent } from "@aura/protocol/types";
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
        const events = inspection.events;
        const end = events.findLast((event) => event.type === "turn/end");
        const answer = events.findLast(
          (event) =>
            event.type === "assistant/message" && !event.data.interrupted,
        );
        const live = ctx.agents.get(child.id);
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
                : end?.type === "turn/end" && end.data.reason.kind === "error"
                  ? "error"
                  : "stopped",
          result:
            answer?.type === "assistant/message"
              ? messageText(answer.data.message.content).slice(0, 12_000)
              : "",
        };
      } catch {
        return {
          id: child.id,
          label: child.label ?? "子 Agent",
          role: "子 Agent",
          status: "error",
          result: "暂时无法读取子 Agent 记录。",
        };
      }
    }),
  );
}
