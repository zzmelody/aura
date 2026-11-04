import type { CodingTurnUsage } from "@aura/protocol/types";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { SessionWireEvent } from "@deepseek-ai/dsh-api-session-controller";
import { deriveTurnTokenUsage } from "@deepseek-ai/dsh-token-meter/client";

/** Reuse the DSH desktop accounting for one complete durable turn. */
export function turnTokenUsage(
  events: ReadonlyArray<SessionEvent | SessionWireEvent>,
): CodingTurnUsage | undefined {
  try {
    // The in-process DSH controller erases event-specific types when it
    // serializes its validated journal. The native fold reads that same data.
    const usage = deriveTurnTokenUsage(events as readonly SessionEvent[]);
    if (!usage) return undefined;
    const { routes: _routes, ...counts } = usage;
    return counts;
  } catch {
    // Unrecognized usage in an older log must not block reading its replies.
    return undefined;
  }
}

/** A live reply may include multiple DSH turns when children report back. */
export function addTurnUsage(
  first: CodingTurnUsage,
  next: CodingTurnUsage,
): CodingTurnUsage | undefined {
  const total: CodingTurnUsage = {
    totalTokens: first.totalTokens + next.totalTokens,
    uncachedInputTokens: first.uncachedInputTokens + next.uncachedInputTokens,
    outputTokens: first.outputTokens + next.outputTokens,
  };
  for (const key of [
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const) {
    const a = first[key];
    const b = next[key];
    if (a !== undefined && b !== undefined) total[key] = a + b;
  }
  return Object.values(total).every(Number.isSafeInteger) ? total : undefined;
}
