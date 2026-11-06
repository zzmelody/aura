import { useEffect, useMemo, useState } from "react";
import { useMessages } from "@aura/i18n";
import { pluginNamespace } from "@aura/i18n/runtime";
import {
  pluginPageInvoke,
  startPluginHost,
  type RegisteredPage,
  type RegisteredResult,
} from "./pluginHost";
import { pluginTab } from "./pluginPages";
import * as workbenchModule from "./plugin-api.ts";

export interface PluginStudio {
  id: `plugin:${string}`;
  title: string;
  description?: string;
  icon?: string;
  pluginId: string;
  page: RegisteredPage;
}

export function usePluginPages(endpoint: string, enabled: boolean) {
  const { t } = useMessages("plugins");
  const [pages, setPages] = useState<RegisteredPage[]>([]);
  const [results, setResults] = useState<RegisteredResult[]>([]);
  const [failures, setFailures] = useState<
    Array<{ id: string; message: string }>
  >([]);

  useEffect(() => {
    if (!enabled) {
      setPages([]);
      setResults([]);
      setFailures([]);
      return;
    }
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let handle: Awaited<ReturnType<typeof startPluginHost>> | undefined;
    const refresh = () => {
      if (!handle || closed) return;
      setPages([...handle.pages.values()]);
      setResults([...handle.results.values()]);
      setFailures([...handle.failures]);
    };
    const start = () => {
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
          timer = setTimeout(start, 3000);
        });
    };
    start();
    return () => {
      closed = true;
      clearTimeout(timer);
      void handle?.close().catch(() => undefined);
    };
  }, [endpoint, enabled]);

  const studios = useMemo<PluginStudio[]>(
    () =>
      pages.map((page) => ({
        id: pluginTab(`${page.pluginId}/${page.definition.id}`),
        title: page.definition.titleKey
          ? t(page.definition.titleKey, {
              ns: pluginNamespace(page.pluginId),
              defaultValue: page.definition.title,
            })
          : page.definition.title,
        description: page.definition.descriptionKey
          ? t(page.definition.descriptionKey, {
              ns: pluginNamespace(page.pluginId),
              defaultValue: page.definition.description ?? "",
            })
          : page.definition.description,
        icon: page.definition.icon,
        pluginId: page.pluginId,
        page,
      })),
    [pages, t],
  );

  return { studios, results, failures, invoke: pluginPageInvoke };
}
