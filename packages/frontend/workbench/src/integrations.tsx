import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { IntegrationFlags } from "@aura/protocol/types";

export async function integrationRequest<T>(
  endpoint: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(
    `${endpoint.replace(/\/$/u, "")}/integrations${path}`,
    options,
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null)
    throw new Error(
      data?.message || `功能服务暂不可用（${response.status}）。`,
    );
  return data as T;
}

const IntegrationContext = createContext<{
  flags?: IntegrationFlags;
  apply: (flags: IntegrationFlags) => void;
}>({ apply: () => undefined });

export function IntegrationProvider({
  endpoint,
  children,
}: {
  endpoint: string;
  children: React.ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<{
    endpoint: string;
    flags: IntegrationFlags;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    void integrationRequest<IntegrationFlags>(endpoint, "/flags", {
      signal: abort.signal,
    })
      .then((flags) => {
        if (!abort.signal.aborted)
          setSnapshot((current) =>
            current?.endpoint === endpoint ? current : { endpoint, flags },
          );
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [endpoint]);
  const apply = useCallback(
    (flags: IntegrationFlags) => setSnapshot({ endpoint, flags }),
    [endpoint],
  );
  const flags = snapshot?.endpoint === endpoint ? snapshot.flags : undefined;
  const value = useMemo(() => ({ flags, apply }), [flags, apply]);
  return (
    <IntegrationContext.Provider value={value}>
      {children}
    </IntegrationContext.Provider>
  );
}

export function useIntegrations() {
  return useContext(IntegrationContext);
}
