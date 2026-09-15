import type {
  ChatEvent,
  ChatMessage,
  CodexAuthStatus,
  CodexLoginRequest,
} from "@aura/protocol/types";
import type { TripoRegion } from "@aura/tripo";

/** Public options accepted by the embeddable Aura backend runtime. */
export interface AuraRuntimeOptions {
  root?: string;
  host?: string;
  port?: number;
}

/** Handle owned by the server or desktop application entrypoint. */
export interface AuraRuntimeHandle {
  url: string;
  close(): Promise<void>;
}

/** Fully resolved, validated runtime configuration. */
export interface RuntimeConfig {
  root: string;
  host: string;
  port: number;
  dshHome: string;
  credentialPath: string;
  dshExecutable: string;
  codexModel: string;
  tripoCredentialPath: string;
  tripoRegion: TripoRegion;
}

export type RuntimeMode = "demo" | "codex-subscription";

/** One DSH provider route selected by the HTTP API. */
export interface DshRoute {
  provider: string;
  model: string;
  reasoningEffort: string;
  maxTokens: number;
  mode: RuntimeMode;
}

export interface DshRunnerOptions {
  root: string;
  dshHome: string;
  dshExecutable: string;
  demoModelUrl: string;
}

/** Authorization capability consumed by the HTTP adapter. */
export interface CodexAuthPort {
  readonly modelId: string;
  status(): Promise<CodexAuthStatus>;
  startLogin(method: CodexLoginRequest["method"]): Promise<CodexAuthStatus>;
  submitLoginInput(input: unknown): CodexAuthStatus;
  cancelLogin(): Promise<CodexAuthStatus>;
}

/** DSH streaming capability consumed by the HTTP adapter. */
export interface DshSessionPort {
  stream(
    messages: ChatMessage[],
    emit: (event: ChatEvent) => void,
    route: DshRoute,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ChatCommand {
  sessionId: string;
  messages: ChatMessage[];
}

export interface CloseableService {
  close(): Promise<void>;
}

export interface DemoModelHandle extends CloseableService {
  url: string;
}

export interface ApiServerHandle extends CloseableService {
  url: string;
}
