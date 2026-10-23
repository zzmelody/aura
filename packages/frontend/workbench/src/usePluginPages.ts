import { useEffect, useMemo, useState } from "react";
import {
  pluginPageInvoke,
  startPluginHost,
  type RegisteredPage,
} from "./pluginHost";
import { pluginTab } from "./pluginPages";
import * as workbenchModule from "./plugin-api.ts";

export interface PluginStudio {
  id: `plugin:${string}`;
  title: string;
  icon?: string;
  pluginId: string;
  page: RegisteredPage;
}

export function usePluginPages(endpoint: string, enabled: boolean) {
  const [pages, setPages] = useState<RegisteredPage[]>([]);
  const [failures, setFailures] = useState<
    Array<{ id: string; message: string }>
  >([]);

  useEffect(() => {
    if (!enabled) {
      setPages([]);
      setFailures([]);
      return;
    }
    let closed = false;
    let handle: Awaited<ReturnType<typeof startPluginHost>> | undefined;
    const refresh = () => {
      if (!handle || closed) return;
      setPages([...handle.pages.values()]);
      setFailures([...handle.failures]);
    };
    void startPluginHost(endpoint, refresh, workbenchModule)
      .then((started) => {
        if (closed) {
          void started.close().catch(() => undefined);
          return;
        }
        handle = started;
        refresh();
      })
      .catch((error: unknown) => {
        if (closed) return;
        setFailures([
          {
            id: "host",
            message: error instanceof Error ? error.message : String(error),
          },
        ]);
      });
    return () => {
      closed = true;
      void handle?.close().catch(() => undefined);
    };
  }, [endpoint, enabled]);

  const studios = useMemo<PluginStudio[]>(
    () =>
      pages.map((page) => ({
        id: pluginTab(`${page.pluginId}/${page.definition.id}`),
        title: page.definition.title,
        icon: page.definition.icon,
        pluginId: page.pluginId,
        page,
      })),
    [pages],
  );

  return { studios, failures, invoke: pluginPageInvoke };
}
