import type {
  FlowCatalog,
  FlowCatalogEntry,
  FlowHistory,
  FlowRun,
  FlowStep,
} from "@aura/protocol/types";
import type { LoadedFlow } from "./registry.ts";

export interface HostOptions {
  root: string;
  dshHome: string;
  modelURL: string;
  codexModel?: string;
  flowRoot?: string;
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
    step: FlowStep & {
      input: string;
      mode: "demo" | "codex";
      timeoutMs: number;
      signal: AbortSignal;
    },
  ): Promise<string>;
  history(step: FlowStep, beforeSeq?: number): Promise<FlowHistory>;
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
}
