import { useEffect, useState } from "react";
import { listAutomation } from "./features/coding/api";
import type { Tab } from "./types";

/**
 * Conversation ids with an active automation task, for the sidebar mark.
 * Re-read on navigation (leaving the automation page picks up edits) and on
 * a slow poll, since a one-shot task ends without any client action.
 */
export function useScheduledConversations(
  endpoint: string,
  enabled: boolean,
  tab: Tab,
): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const read = () =>
      listAutomation(endpoint, abort.signal)
        .then((tasks) =>
          setIds(
            new Set(
              tasks
                .filter((task) => task.status === "active")
                .map((task) => task.sessionId),
            ),
          ),
        )
        .catch(() => {});
    void read();
    const timer = window.setInterval(() => void read(), 60_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [endpoint, enabled, tab]);
  return ids;
}
