import type {
  FlowCatalog,
  FlowCatalogEntry,
  FlowHistory,
  FlowRun,
  FlowAgentStep,
} from "@aura/protocol/types";
import type { LoadedFlow } from "./registry.ts";
import type { ActionRegistry, LoadedAction } from "./action-registry.ts";
import type { ActionRuntime } from "./actions.ts";

export interface HostOptions {
  root: string;
  dshHome: string;
  modelURL: string;
  codexModel?: string;
  flowRoot?: string;
  actionRoot?: string;
}

export type FlowRpcResult<T> =
  { ok: true; data: T } | { ok: false; status: number; message: string };

export interface Table<T> {
  get(id: string): T | undefined;
  entries(): IterableIterator<[string, T]>;
  put(id: string, value: T): Promise<void>;
  update(id: string, change: (current: T) => T): Promise<T>;
}

export interface FlowDomain {
  table(name: "runs"): Table<FlowRun>;
}

export interface SessionPort {
  execute(
    step: FlowAgentStep & {
      input: string;
      mode: "demo" | "codex";
      timeoutMs: number;
      signal: AbortSignal;
      runId: string;
      actionDefinitions: readonly LoadedAction[];
    },
  ): Promise<string>;
  history(step: FlowAgentStep, beforeSeq?: number): Promise<FlowHistory>;
}

export interface EngineOptions {
  domain: FlowDomain;
  sessions: SessionPort;
  registry: {
    get(id: string): LoadedFlow;
    catalog(): FlowCatalogEntry[];
  };
  refreshFlows(): Promise<void>;
  presets(): Promise<FlowCatalog["presets"]>;
  actions?: {
    registry: Pick<ActionRegistry, "snapshot" | "catalog">;
    runtime: Pick<ActionRuntime, "execute">;
    cwd: string;
  };
}
