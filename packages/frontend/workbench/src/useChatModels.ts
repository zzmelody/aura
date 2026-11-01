import { useCallback, useSyncExternalStore } from "react";
import type { FlowMode } from "@aura/protocol/types";
import {
  modelCatalogs,
  type ModelCatalogSnapshot,
} from "./model-catalog-store.ts";

const disabledSnapshot: ModelCatalogSnapshot = { loading: false, error: "" };

export function useChatModels(
  endpoint: string,
  mode: FlowMode,
  enabled = true,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? modelCatalogs.subscribe(endpoint, mode, listener) : () => {},
    [endpoint, mode, enabled],
  );
  const getSnapshot = useCallback(
    () => (enabled ? modelCatalogs.snapshot(endpoint, mode) : disabledSnapshot),
    [endpoint, mode, enabled],
  );
  return {
    ...useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
    refresh: () => void modelCatalogs.refresh(endpoint, mode),
  };
}
