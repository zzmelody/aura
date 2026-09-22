import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { FlowRun } from "@aura/protocol/types";
import type { ArtifactOwner } from "./workflow-artifacts.ts";

/** Reads structured JSON results only, never extracts paths from prose. */
export function historicalArtifactReader(ctx: Context) {
  return async (
    run: FlowRun,
    capture: (
      owner: ArtifactOwner,
      value: unknown,
      producer: string,
    ) => Promise<void>,
  ) => {
    for (const step of run.steps) {
      if (step.kind && step.kind !== "agent") continue;
      const sessions = step.attempts?.length
        ? step.attempts.map((attempt) => ({
            sessionId:
              attempt.sessionId ??
              (attempt.number === step.attempts?.at(-1)?.number
                ? step.sessionId
                : undefined),
            number: attempt.number,
          }))
        : [{ sessionId: step.sessionId, number: undefined }];
      for (const attempt of sessions) {
        if (!attempt.sessionId) continue;
        let inspection;
        try {
          inspection = await ctx.sessionController.inspect(
            SessionId(attempt.sessionId),
            AbortSignal.timeout(15_000),
          );
        } catch {
          continue;
        } // Legacy logs may have been removed; never re-run the tool.
        const calls = new Map<string, string>();
        for (const event of inspection.events) {
          if (event.type === "tool/call")
            calls.set(event.data.callId, event.data.name);
          if (event.type !== "tool/result" || event.data.error) continue;
          const scan = async (
            value: unknown,
            callId?: string,
          ): Promise<void> => {
            if (!value || typeof value !== "object") return;
            if (Array.isArray(value)) {
              for (const item of value) await scan(item, callId);
              return;
            }
            const item = value as Record<string, unknown>;
            if (item.isError === true) return;
            const id =
              typeof item.toolCallId === "string" ? item.toolCallId : callId;
            if (item.type === "text" && typeof item.text === "string") {
              let output: unknown;
              try {
                output = JSON.parse(item.text);
              } catch {
                return;
              }
              await capture(
                {
                  runId: run.id,
                  stepKey: step.stepKey ?? step.id,
                  attempt: attempt.number,
                  callId: id,
                },
                output,
                calls.get(id ?? "") ?? "historical-tool",
              );
            }
            if (item.content) await scan(item.content, id);
          };
          await scan(event.data.message.content);
        }
      }
    }
    return true;
  };
}
