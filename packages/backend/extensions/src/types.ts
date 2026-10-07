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
}

/** A plugin's provider directory plus the opaque settings handed to its providers. */
export interface PluginCapabilityRoot extends PluginContributionRoot {
  settings?: JsonValue;
}

export interface AuraPluginResolution {
  actionRoots: PluginContributionRoot[];
  flowRoots: PluginContributionRoot[];
  capabilityRoots: PluginCapabilityRoot[];
  plugins: AuraPluginStatus[];
}

export interface LoadAuraPluginsOptions {
  configPath: string;
  auraVersion: string;
  pluginSdkVersion: string;
  supportedCapabilities?: readonly string[];
}

export class AuraPluginConfigurationError extends Error {}
