import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifest = require("@aura/plugin-sdk/package.json") as {
  version?: unknown;
};

if (typeof manifest.version !== "string" || !manifest.version)
  throw new Error("@aura/plugin-sdk package version is unavailable.");

/** Keep plugin compatibility checks pinned to the SDK package actually loaded. */
export const pluginSdkVersion = manifest.version;
