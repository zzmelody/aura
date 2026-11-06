import type { ApiErrorDetails } from "@aura/protocol/errors";
import type {
  PluginCompatibility,
  PluginHttpContribution,
} from "@aura/protocol/types";
import type {
  AuraPluginIdentity,
  AuraPluginStatus,
  JsonValue,
} from "@aura/protocol/types";
export interface PluginContributionRoot {
  pluginRoot: string;
  path: string;
  namespace: string;
  plugin: AuraPluginIdentity;
  /** Built-in host capabilities granted by the manifest `permissions`. */
  permissions: string[];
  compatibility?: PluginCompatibility;
  http?: PluginHttpContribution;
  presets?: string;
}

/** A plugin's backend entry (`path`) plus the opaque settings handed to it. */
export interface PluginBackendRoot extends PluginContributionRoot {
  settings?: JsonValue;
}

/** A plugin's prebuilt browser bundle: one lazy-CJS entry that registers pages. */
export interface PluginPageRoot {
  pluginRoot: string;
  /** Absolute path of the built `client.js` bundle, inside `pluginRoot`. */
  bundlePath: string;
  plugin: AuraPluginIdentity;
}

export interface AuraPluginResolution {
  actionRoots: PluginContributionRoot[];
  flowRoots: PluginContributionRoot[];
  backendRoots: PluginBackendRoot[];
  pageRoots: PluginPageRoot[];
  plugins: AuraPluginStatus[];
}

export interface LoadAuraPluginsOptions {
  configPath: string;
  /** Trusted repository/release directory, recursively discovered before loading. */
  defaultPluginsDirectory?: string;
  auraVersion: string;
  pluginSdkVersion: string;
  /** Built-in host capability IDs a manifest may list in `permissions`. */
  supportedPermissions?: readonly string[];
}

export class AuraPluginConfigurationError extends Error {
  readonly details: ApiErrorDetails;
  constructor(
    message: string,
    details: ApiErrorDetails = { code: "plugin_configuration_invalid" },
  ) {
    super(message);
    this.details = details;
  }
}
