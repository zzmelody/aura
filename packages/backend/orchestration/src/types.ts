import type {
  PluginCompatibility,
  PluginHttpContribution,
} from "@aura/protocol/types";
import type { JsonValue, FlowMode } from "@aura/protocol/types";
import type { FlowImageReference } from "./flow-api.ts";
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

export interface ContributionRoot {
  root: string;
  namespace?: string;
  plugin?: AuraPluginIdentity;
  /** Trusted local package root, never projected into public catalog DTOs. */
  pluginRoot?: string;
  /** Built-in host capabilities granted by the manifest `permissions`. */
  permissions?: string[];
  compatibility?: PluginCompatibility;
  http?: PluginHttpContribution;
  presets?: string;
}

/** A plugin's backend entry module (`root`) and its opaque plugins.json settings. */
export interface BackendRoot extends ContributionRoot {
  settings?: JsonValue;
}

export interface ContributionConfiguration {
  flowRoots: ContributionRoot[];
  actionRoots: ContributionRoot[];
  backendRoots?: BackendRoot[];
  plugins: AuraPluginStatus[];
}

export interface Table<T> {
  get(id: string): T | undefined;
  entries(): IterableIterator<[string, T]>;
  put(id: string, value: T): Promise<void>;
  delete(id: string): Promise<boolean>;
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
      images?: FlowImageReference[];
      mode: FlowMode;
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
  resolveAgentDefaults?(
    mode: FlowMode | "configured",
  ): Promise<FlowAgentConfig>;
  domain: FlowDomain;
  sessions: SessionPort;
  registry: {
    get(id: string): LoadedFlow;
    catalog(): FlowCatalogEntry[];
  };
  refreshFlows(): Promise<void>;
  presets(): Promise<FlowCatalog["presets"]>;
  plugins?: AuraPluginStatus[];
  /** Called once per root Run after it reaches a terminal status. */
  onRootSettled?(run: FlowRun): Promise<void>;
  actions?: {
    registry: Pick<ActionRegistry, "snapshot" | "catalog">;
    runtime: Pick<ActionRuntime, "execute">;
    cwd: string;
  };
}
