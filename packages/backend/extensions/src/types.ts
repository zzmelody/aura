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
  capabilities: string[];
  compatibility?: PluginCompatibility;
  http?: PluginHttpContribution;
  presets?: string;
}

/** A plugin's provider directory plus the opaque settings handed to its providers. */
export interface PluginCapabilityRoot extends PluginContributionRoot {
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
  capabilityRoots: PluginCapabilityRoot[];
  pageRoots: PluginPageRoot[];
  plugins: AuraPluginStatus[];
}

export interface LoadAuraPluginsOptions {
  configPath: string;
  /** Trusted repository/release directory, recursively discovered before loading. */
  defaultPluginsDirectory?: string;
  auraVersion: string;
  pluginSdkVersion: string;
  supportedCapabilities?: readonly string[];
}

export class AuraPluginConfigurationError extends Error {}
