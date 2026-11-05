import { fileURLToPath } from "node:url";

export const defaultFlowRoot = fileURLToPath(
  new URL("../flow", import.meta.url),
);
export const defaultActionRoot = fileURLToPath(
  new URL("../action", import.meta.url),
);
export const flowPresetRoot = fileURLToPath(
  new URL("../presets", import.meta.url),
);

export { PluginHttpRegistry } from "./plugin-http.ts";
export {
  defaultPluginSdkPackage,
  installHostPluginSdkResolution,
  installHostPluginSdkResolutionFromEnv,
  PLUGIN_SDK_ENV,
} from "./plugin-sdk-resolution.ts";
export { artifactResponse, type ArtifactFile } from "./artifacts/http.ts";
export { GeneratedArtifacts } from "./artifacts/generated.ts";
export { jsonValue } from "./schema.ts";
export type {
  BackendRoot,
  ContributionConfiguration,
  ContributionRoot,
} from "./types.ts";

export { GPT_IMAGE_CAPABILITY } from "./gpt-image.ts";
export { LEGACY_TRIPO_PERMISSION } from "./plugin-capability-compatibility.ts";
export { MANAGED_PROCESS_PERMISSION } from "./managed-process/process.ts";
