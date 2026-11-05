import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { FlowError } from "@aura/protocol/errors";

export interface HistoryCursor {
  beforeSeq?: number;
  throughSeq?: number;
}

/** A UI window over DSH-validated events; cursors also work with the live reader. */
export function storedHistoryPage(
  events: readonly SessionEvent[],
  minimumSeq: number,
  cursor: HistoryCursor,
):
  | {
      events: readonly SessionEvent[];
      hasMore: boolean;
      beforeSeq?: number;
      throughSeq: number;
    }
  | undefined {
  const throughSeq = cursor.throughSeq ?? events.at(-1)?.seq ?? -1;
  if (
    !Number.isSafeInteger(throughSeq) ||
    throughSeq < -1 ||
    throughSeq > (events.at(-1)?.seq ?? -1) ||
    (cursor.beforeSeq === undefined) !== (cursor.throughSeq === undefined) ||
    (cursor.beforeSeq !== undefined &&
      (!Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 0))
  )
    throw new FlowError("无效的历史分页游标。", 400);

  const own = events.filter((event) => event.seq >= minimumSeq);
  const complete = (slice: readonly SessionEvent[]) => {
    let open = false;
    for (const event of slice) {
      if (event.type === "turn/start") open = true;
      else if (event.type === "turn/end") open = false;
    }
    return !open;
  };
  // The live host alone knows whether an unfinished turn is still running.
  if (!complete(own)) return undefined;
  const window = own.filter(
    (event) =>
      event.seq <= throughSeq &&
      (cursor.beforeSeq === undefined || event.seq < cursor.beforeSeq),
  );
  if (!complete(window)) return undefined;
  const starts = window.flatMap((event, index) =>
    event.type === "turn/start" ? [index] : [],
  );
  const first = starts.at(-10) ?? starts[0];
  const selected = first === undefined ? [] : window.slice(first);
  return {
    events: selected,
    hasMore: starts.length > 10,
    beforeSeq: selected[0]?.seq,
    throughSeq,
  };
}
