import { useCallback, useSyncExternalStore } from "react";
import { workflowRuns } from "./workflow-run-store";
import { messageText } from "@aura/i18n/runtime";
import { useWorkflowMessages } from "./workflow-messages.ts";

export function useWorkflowRun(endpoint: string, id: string) {
  const { i18n } = useWorkflowMessages();
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
  return {
    ...state,
    error: state.error ? messageText(state.error, i18n) : undefined,
    refresh,
  };
}
