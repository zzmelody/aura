import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MetadataOwner } from "./metadata.ts";
import type { FlowCatalog } from "@aura/protocol/types";
import { apiErrorText } from "./api-error-messages.ts";
import {
  errorMessage,
  MessageError,
  messageText,
  type MessageReference,
} from "@aura/i18n/runtime";
import {
  useWorkflowMessages,
  workflowMessage as message,
} from "./workflow-messages";

const messageFor = (cause: unknown) =>
  errorMessage(cause, message("catalogUnavailable"));

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
    throw new MessageError(
      apiErrorText(
        result,
        message("catalogReadFailed", { status: response.status }),
      ),
    );
  return { catalog: result as FlowCatalog, etag: response.headers.get("ETag") };
}

export function useFlowCatalog(endpoint: string) {
  const { i18n } = useWorkflowMessages();
  const metadata = useMemo(() => new MetadataOwner(i18n), [i18n]);
  const [catalog, setCatalog] = useState<FlowCatalog>();
  const [error, setError] = useState<string | MessageReference>("");
  const [refreshing, setRefreshing] = useState(false);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const validator = useRef<{ endpoint: string; etag?: string }>({ endpoint });
  const receive = useCallback(
    (
      requestedEndpoint: string,
      next: Awaited<ReturnType<typeof readCatalog>>,
    ) => {
      if (
        !next ||
        !metadata.active ||
        endpointRef.current !== requestedEndpoint
      )
        return;
      validator.current = {
        endpoint: requestedEndpoint,
        etag: next.etag ?? undefined,
      };
      setCatalog(metadata.catalog(next.catalog));
      setError("");
    },
    [metadata],
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
    metadata.activate();
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
      metadata.dispose();
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [endpoint, receive, metadata]);

  return { catalog, error: messageText(error, i18n), refreshing, refresh };
}

export type FlowCatalogController = ReturnType<typeof useFlowCatalog>;
