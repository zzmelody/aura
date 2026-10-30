import { createRequire, registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SDK = "@aura/plugin-sdk";

/** Environment variable carrying the host SDK `package.json` path to child processes. */
export const PLUGIN_SDK_ENV = "AURA_PLUGIN_SDK_PACKAGE";

let installed: string | undefined;

/**
 * Makes every plugin resolve `@aura/plugin-sdk` to the copy this host ships.
 *
 * The SDK is a host contract, not a plugin dependency: plugins compile against
 * it and never ship or link their own copy. Resolving from the host keeps one
 * module instance per process, so SDK classes and identity checks agree
 * between the host and every plugin. Compatibility is decided only by the
 * manifest `engines.pluginSdk` range against the host SDK version.
 *
 * `sdkPackageJson` is the host SDK's `package.json`. SDK specifiers resolve as
 * a self-reference from inside that package; every other import is untouched.
 * The hook is process-wide and installed once.
 */
export function installHostPluginSdkResolution(sdkPackageJson: string): void {
  if (installed !== undefined) {
    if (installed !== sdkPackageJson)
      throw new Error("Plugin SDK resolution is already bound to another SDK.");
    return;
  }
  installed = sdkPackageJson;
  const parentURL = pathToFileURL(sdkPackageJson).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === SDK || specifier.startsWith(`${SDK}/`))
        return next(specifier, { ...context, parentURL });
      return next(specifier, context);
    },
  });
}

/**
 * The SDK next to this package. The SDK depends on orchestration, so
 * orchestration cannot declare it; applications pass `pluginSdkPackage`
 * explicitly and this default only serves the workspace (tests, tools).
 */
export function defaultPluginSdkPackage(): string {
  try {
    return createRequire(import.meta.url).resolve(
      "@aura/plugin-sdk/package.json",
    );
  } catch {
    const sibling = fileURLToPath(
      new URL("../../plugin-sdk/package.json", import.meta.url),
    );
    if (existsSync(sibling)) return sibling;
    throw new Error("Host @aura/plugin-sdk is unavailable.");
  }
}

/** Installs the hook from `AURA_PLUGIN_SDK_PACKAGE`; child processes call this. */
export function installHostPluginSdkResolutionFromEnv(): void {
  const path = process.env[PLUGIN_SDK_ENV];
  if (!path) throw new Error(`${PLUGIN_SDK_ENV} is not set.`);
  installHostPluginSdkResolution(path);
}
