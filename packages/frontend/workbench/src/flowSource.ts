import { useEffect, useState } from "react";
import type { FlowSource } from "@aura/protocol/types";

/** Fetch only the selected entry; switching selection cancels stale previews. */
export function useFlowSource(
  endpoint: string,
  id: string,
  revision?: string | number,
) {
  const key = `${endpoint}\n${id}\n${revision ?? ""}`;
  const [result, setResult] = useState<{
    key: string;
    source?: FlowSource;
    error?: string;
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
          throw new Error(
            `无法读取流程预览（${response.status}），请确认服务已更新。`,
          );
        const source = (await response.json()) as FlowSource;
        if (source.id !== id || typeof source.code !== "string")
          throw new Error("流程预览内容无效。");
        if (!abort.signal.aborted) setResult({ key, source });
      } catch (cause) {
        if (!abort.signal.aborted)
          setResult({
            key,
            error:
              cause instanceof Error ? cause.message : "无法读取流程预览。",
          });
      }
    })();
    return () => abort.abort();
  }, [endpoint, id, key, retry]);
  return {
    source: result?.key === key ? result.source : undefined,
    error: result?.key === key ? result.error : undefined,
    refresh: () => setRetry((value) => value + 1),
  };
}
