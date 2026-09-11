import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowCatalog } from "@aura/protocol/types";

const messageFor = (cause: unknown) =>
  cause instanceof Error ? cause.message : "流程目录暂时不可用。";

async function readCatalog(endpoint: string, signal?: AbortSignal) {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/flows/catalog`, {
    signal,
  });
  const result = (await response.json().catch(() => null)) as
    FlowCatalog | { message?: string } | null;
  if (!response.ok)
    throw new Error(
      (result &&
        typeof result === "object" &&
        "message" in result &&
        result.message) ||
        `Flow 目录读取失败（${response.status}）。`,
    );
  return result as FlowCatalog;
}

export function useFlowCatalog(endpoint: string) {
  const [catalog, setCatalog] = useState<FlowCatalog>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;

  const refresh = useCallback(async () => {
    const requestedEndpoint = endpoint;
    setRefreshing(true);
    try {
      const next = await readCatalog(requestedEndpoint);
      if (endpointRef.current !== requestedEndpoint) return;
      setCatalog(next);
      setError("");
    } catch (cause) {
      if (endpointRef.current === requestedEndpoint)
        setError(messageFor(cause));
    } finally {
      if (endpointRef.current === requestedEndpoint) setRefreshing(false);
    }
  }, [endpoint]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCatalog(undefined);
    setError("");
    const poll = async () => {
      try {
        const next = await readCatalog(endpoint, abort.signal);
        if (!abort.signal.aborted) {
          setCatalog(next);
          setError("");
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(messageFor(cause));
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1_500);
    };
    void poll();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [endpoint]);

  return { catalog, error, refreshing, refresh };
}

export type FlowCatalogController = ReturnType<typeof useFlowCatalog>;
