import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowCatalog } from "@aura/protocol/types";

const messageFor = (cause: unknown) =>
  cause instanceof Error ? cause.message : "流程目录暂时不可用。";

async function readCatalog(
  endpoint: string,
  etag?: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/flows/catalog`, {
    signal,
    headers: etag ? { "If-None-Match": etag } : undefined,
  });
  if (response.status === 304) return undefined;
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
  return { catalog: result as FlowCatalog, etag: response.headers.get("ETag") };
}

export function useFlowCatalog(endpoint: string) {
  const [catalog, setCatalog] = useState<FlowCatalog>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const validator = useRef<{ endpoint: string; etag?: string }>({ endpoint });
  const receive = useCallback(
    (
      requestedEndpoint: string,
      next: Awaited<ReturnType<typeof readCatalog>>,
    ) => {
      if (!next || endpointRef.current !== requestedEndpoint) return;
      validator.current = {
        endpoint: requestedEndpoint,
        etag: next.etag ?? undefined,
      };
      setCatalog(next.catalog);
      setError("");
    },
    [],
  );

  const refresh = useCallback(async () => {
    const requestedEndpoint = endpoint;
    setRefreshing(true);
    try {
      const next = await readCatalog(
        requestedEndpoint,
        validator.current.endpoint === endpoint
          ? validator.current.etag
          : undefined,
      );
      if (endpointRef.current !== requestedEndpoint) return;
      receive(requestedEndpoint, next);
      setError("");
    } catch (cause) {
      if (endpointRef.current === requestedEndpoint)
        setError(messageFor(cause));
    } finally {
      if (endpointRef.current === requestedEndpoint) setRefreshing(false);
    }
  }, [endpoint, receive]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCatalog(undefined);
    setError("");
    validator.current = { endpoint };
    let polling = false;
    let available = false;
    const poll = async () => {
      if (polling || abort.signal.aborted) return;
      if (timer) clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      polling = true;
      try {
        const next = await readCatalog(
          endpoint,
          validator.current.etag,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          receive(endpoint, next);
          available = true;
          setError("");
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(messageFor(cause));
      }
      polling = false;
      if (!abort.signal.aborted)
        timer = setTimeout(poll, available ? 15_000 : 1_500);
    };
    void poll();
    const wake = () => void poll();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [endpoint, receive]);

  return { catalog, error, refreshing, refresh };
}

export type FlowCatalogController = ReturnType<typeof useFlowCatalog>;
