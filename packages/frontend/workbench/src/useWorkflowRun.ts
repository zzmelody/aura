import { useCallback, useSyncExternalStore } from "react";
import { workflowRuns } from "./workflow-run-store";

export function useWorkflowRun(endpoint: string, id: string) {
  const subscribe = useCallback(
    (listener: () => void) => workflowRuns.subscribe(endpoint, id, listener),
    [endpoint, id],
  );
  const snapshot = useCallback(
    () => workflowRuns.snapshot(endpoint, id),
    [endpoint, id],
  );
  const state = useSyncExternalStore(subscribe, snapshot);
  const refresh = useCallback(() => {
    void workflowRuns.refresh(endpoint, id).catch(() => undefined);
  }, [endpoint, id]);
  return { ...state, refresh };
}
