import type {
  FlowDefinition,
  FlowHistory,
  FlowRun,
  FlowStep,
  SavedFlowDefinition,
  FlowCatalog,
} from "@aura/protocol/types";

export interface HostOptions {
  root: string;
  dshHome: string;
  modelURL: string;
  codexModel?: string;
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
  table(name: "definitions"): Table<SavedFlowDefinition>;
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
  presets(): Promise<FlowCatalog["presets"]>;
}
export type NodeDefinition = FlowDefinition["nodes"][number];
