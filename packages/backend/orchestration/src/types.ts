import type {
  FlowCatalog,
  FlowCatalogEntry,
  FlowHistory,
  FlowRun,
  FlowAgentStep,
  FlowAgentConfig,
  AuraPluginIdentity,
  AuraPluginStatus,
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
  flowRoots?: ContributionRoot[];
  actionRoots?: ContributionRoot[];
  plugins?: AuraPluginStatus[];
  worldAgentSessionPath?: string;
  tripoCredentialPath?: string;
  tripoRegion?: "global" | "china";
}

export interface ContributionRoot {
  root: string;
  namespace?: string;
  plugin?: AuraPluginIdentity;
  capabilities?: string[];
}

export interface ContributionConfiguration {
  flowRoots: ContributionRoot[];
  actionRoots: ContributionRoot[];
  plugins: AuraPluginStatus[];
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
  /** Validate exact provider/model controls without starting a session or a model request. */
  validateConfig?(config: FlowAgentConfig): Promise<void>;
  execute(
    step: FlowAgentStep & {
      input: string;
      images?: import("./flow-api.ts").FlowImageReference[];
      mode: "demo" | "codex";
      timeoutMs: number;
      signal: AbortSignal;
      runId: string;
      actionDefinitions: readonly LoadedAction[];
    },
  ): Promise<string>;
  history(step: FlowAgentStep, beforeSeq?: number): Promise<FlowHistory>;
  reconcile?(step: FlowAgentStep): Promise<{
    output?: string;
    actionStarted: boolean;
  }>;
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
  plugins?: AuraPluginStatus[];
  actions?: {
    registry: Pick<ActionRegistry, "snapshot" | "catalog">;
    runtime: Pick<ActionRuntime, "execute">;
    cwd: string;
  };
}
