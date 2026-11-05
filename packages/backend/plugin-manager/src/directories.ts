import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuraPluginConfiguration } from "@aura/protocol/types";
import type { LoadAuraPluginsOptions } from "./types.ts";

/** Repository/release plugins are trusted code; never follow directory links. */
export async function discoverAuraPluginDirectories(
  directory: string,
): Promise<string[]> {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (
    children.some(
      (entry) => entry.name === "aura.plugin.json" && entry.isFile(),
    )
  ) {
    return [resolve(directory)];
  }
  const result: string[] = [];
  for (const entry of children.sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      ["node_modules", "dist", "dist-host", "runtime"].includes(entry.name)
    ) {
      continue;
    }
    result.push(
      ...(await discoverAuraPluginDirectories(resolve(directory, entry.name))),
    );
  }
  return result;
}

async function pluginId(directory: string): Promise<string | undefined> {
  try {
    const source: unknown = JSON.parse(
      await readFile(resolve(directory, "aura.plugin.json"), "utf8"),
    );
    if (
      source &&
      typeof source === "object" &&
      "id" in source &&
      typeof source.id === "string"
    ) {
      return source.id;
    }
  } catch {
    // Validation reports invalid configured plugins; discovery does not execute code.
  }
  return undefined;
}

/** Merges defaults with explicit enable/disable/settings overrides without writing config. */
export async function resolveAuraPluginEntries(
  configuration: AuraPluginConfiguration,
  options: LoadAuraPluginsOptions,
): Promise<AuraPluginConfiguration> {
  if (!options.defaultPluginsDirectory) return configuration;
  const directory = resolve(options.defaultPluginsDirectory);
  const defaults = await discoverAuraPluginDirectories(directory);
  const configured = [];
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const entry of configuration.plugins) {
    const path = resolve(dirname(options.configPath), entry.path);
    configured.push({ ...entry, path });
    paths.add(path);
    const id = await pluginId(path);
    if (id) ids.add(id);
  }
  for (const path of defaults) {
    const id = await pluginId(path);
    if (paths.has(path) || (id && ids.has(id))) continue;
    configured.push({ path, enabled: true, trust: "local" as const });
    // Keep duplicate default IDs in the list: normal validation must report them.
  }
  return { version: 1, plugins: configured };
}
