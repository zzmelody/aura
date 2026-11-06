import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceTerminalInfo } from "@aura/protocol/types";
import { listTerminals, openTerminal, closeTerminal } from "./api";
import { useToolMessages, type ToolMessageKey } from "../../tool-messages.ts";

export function useWorkspaceTerminals(endpoint: string, projectId?: string) {
  const { t } = useToolMessages();
  const [lists, setLists] = useState<Record<string, WorkspaceTerminalInfo[]>>(
    {},
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<"" | ToolMessageKey>("");
  const closed = useRef(new Set<string>());
  const revisions = useRef(new Map<string, number>());
  const key = `${endpoint}\n${projectId ?? ""}`;
  const update = useCallback(
    (info: WorkspaceTerminalInfo) => {
      if (closed.current.has(`${endpoint}\n${info.id}`)) return;
      const scope = `${endpoint}\n${info.projectId}`;
      setLists((current) => {
        const list = current[scope] ?? [];
        const previous = list.find((item) => item.id === info.id);
        if (
          previous &&
          previous.status === info.status &&
          previous.activity === info.activity &&
          previous.exitCode === info.exitCode
        )
          return current;
        revisions.current.set(scope, (revisions.current.get(scope) ?? 0) + 1);
        return {
          ...current,
          [scope]: previous
            ? list.map((item) => (item.id === info.id ? info : item))
            : [...list, info],
        };
      });
    },
    [endpoint],
  );
  useEffect(() => {
    if (!projectId) return;
    const abort = new AbortController();
    const revision = revisions.current.get(key);
    listTerminals(endpoint, projectId, abort.signal)
      .then((list) => {
        if (!abort.signal.aborted && revision === revisions.current.get(key)) {
          setLists((current) => ({
            ...current,
            [key]: list.filter(
              (item) => !closed.current.has(`${endpoint}\n${item.id}`),
            ),
          }));
          setError("");
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("terminalListFailed");
      });
    return () => abort.abort();
  }, [endpoint, projectId, key]);
  return {
    current: lists[key] ?? [],
    all: Object.entries(lists)
      .filter(([scope]) => scope.startsWith(`${endpoint}\n`))
      .flatMap(([, list]) => list),
    creating,
    error: error ? t(error) : "",
    update,
    async create() {
      if (!projectId || creating) return undefined;
      setCreating(true);
      setError("");
      try {
        const info = await openTerminal(endpoint, projectId);
        update(info);
        return info;
      } catch {
        setError("terminalOpenFailed");
        return undefined;
      } finally {
        setCreating(false);
      }
    },
    async close(info: WorkspaceTerminalInfo, force = false) {
      await closeTerminal(endpoint, info.id, force);
      closed.current.add(`${endpoint}\n${info.id}`);
      const scope = `${endpoint}\n${info.projectId}`;
      revisions.current.set(scope, (revisions.current.get(scope) ?? 0) + 1);
      setLists((current) => ({
        ...current,
        [scope]: (current[scope] ?? []).filter((item) => item.id !== info.id),
      }));
    },
  };
}
