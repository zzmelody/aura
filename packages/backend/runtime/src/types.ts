import type {
  ChatEvent,
  ChatMessage,
  ChatModelCatalog,
  ChatModelSelection,
  CodexAuthStatus,
  CodexLoginRequest,
  AuraPluginSettingsState,
} from "@aura/protocol/types";
import type { TripoRegion } from "@aura/tripo";

/** Public options accepted by the embeddable Aura backend runtime. */
export interface AuraRuntimeOptions {
  root?: string;
  host?: string;
  port?: number;
  /** Defaults to <root>/.aura/plugins.json. */
  pluginConfigPath?: string;
  /** Trusted installed plugins; defaults to <root>/plugins. Separate from user data. */
  defaultPluginsDirectory?: string;
  /** Disposable runtime scratch space; defaults to AURA_TEMP_DIR or <root>/local/runtime. */
  tempDir?: string;
  /** Working directory for conversations without a project; defaults to
   * AURA_DEFAULT_WORKSPACE or <Documents>/Aura, outside the Aura root. */
  defaultWorkspace?: string;
}

/** Handle owned by the server or desktop application entrypoint. */
export interface AuraRuntimeHandle {
  url: string;
  /** Resolves only after DSH has completed the Aura initialize handshake. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** Fully resolved, validated runtime configuration. */
export interface RuntimeConfig {
  root: string;
  host: string;
  port: number;
  dshHome: string;
  credentialPath: string;
  codexModel: string;
  tripoCredentialPath: string;
  tripoRegion: TripoRegion;
  pluginConfigPath: string;
  defaultPluginsDirectory: string;
  tempDir: string;
  defaultWorkspace: string;
}

/** Authorization capability consumed by the HTTP adapter. */
export interface CodexAuthPort {
  readonly modelId: string;
  status(): Promise<CodexAuthStatus>;
  startLogin(method: CodexLoginRequest["method"]): Promise<CodexAuthStatus>;
  submitLoginInput(input: unknown): CodexAuthStatus;
  cancelLogin(): Promise<CodexAuthStatus>;
}

/** Chat target selected by the HTTP API route. */
export interface ChatRoute {
  /** Flow mode of the chat model and of any workflow it starts. */
  mode: "demo" | "codex" | "lumina" | "custom";
  model?: string;
}

/** Streams one chat turn; workflow tool starts arrive as `workflow` events. */
export interface ChatPort {
  chatModels(
    mode: ChatRoute["mode"],
    signal: AbortSignal,
  ): Promise<ChatModelCatalog>;
  chat(
    turn: {
      sessionId?: string;
      messages: ChatMessage[];
      mode: ChatRoute["mode"];
    } & ChatModelSelection,
    emit: (event: ChatEvent) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }>;
  /** Streams one turn of a persistent coding conversation. Optional so a
   * host without coding support still satisfies this port. */
  coding?(
    turn: {
      sessionId: string;
      projectId: string;
      prompt: string;
      /** Uploaded chat image asset IDs. */
      images?: string[];
      /** Set on a side chat: the conversation it branches from. */
      forkFrom?: string;
      mode: ChatRoute["mode"];
    } & ChatModelSelection,
    emit: (event: unknown) => void,
    signal: AbortSignal,
  ): Promise<{ model: string }>;
}

/** Fixed-path plugin configuration exposed only by a loopback runtime. */
export interface AuraPluginSettingsPort {
  settings(): Promise<AuraPluginSettingsState>;
  updateSettings(source: unknown): Promise<AuraPluginSettingsState>;
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
