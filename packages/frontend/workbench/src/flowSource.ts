import { useEffect, useState } from "react";
import type { FlowSource } from "@aura/protocol/types";
import {
  MessageError,
  errorMessage,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  useWorkflowMessages,
  workflowMessage as message,
} from "./workflow-messages.ts";

/** Fetch only the selected entry; switching selection cancels stale previews. */
export function useFlowSource(
  endpoint: string,
  id: string,
  revision?: string | number,
) {
  const { i18n } = useWorkflowMessages();
  const key = `${endpoint}\n${id}\n${revision ?? ""}`;
  const [result, setResult] = useState<{
    key: string;
    source?: FlowSource;
    error?: string | MessageReference;
  }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    setResult(undefined);
    void (async () => {
      try {
        const response = await fetch(
          `${endpoint.replace(/\/$/, "")}/flows/${encodeURIComponent(id)}/source`,
          { signal: abort.signal },
        );
        if (!response.ok)
          throw new MessageError(
            message("previewRequestFailed", { status: response.status }),
          );
        const source = (await response.json()) as FlowSource;
        if (source.id !== id || typeof source.code !== "string")
          throw new MessageError(message("previewInvalid"));
        if (!abort.signal.aborted) setResult({ key, source });
      } catch (cause) {
        if (!abort.signal.aborted)
          setResult({
            key,
            error: errorMessage(cause, message("previewFailed")),
          });
      }
    })();
    return () => abort.abort();
  }, [endpoint, id, key, retry]);
  return {
    source: result?.key === key ? result.source : undefined,
    error:
      result?.key === key && result.error
        ? messageText(result.error, i18n)
        : undefined,
    refresh: () => setRetry((value) => value + 1),
  };
}
