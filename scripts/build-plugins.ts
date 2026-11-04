import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { discoverAuraPluginDirectories } from "@aura/plugin-manager";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set([
  "node_modules",
  "runtime",
  "state",
  "secrets",
  "cache",
  "data",
  "exports",
  "__pycache__",
  ".git",
  ".aura",
]);

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix);
}

async function copyAsset(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink())
    throw new Error("Plugin releases cannot contain links.");
  if (info.isDirectory()) {
    for (const entry of await readdir(source)) {
      if (entry.startsWith(".") || excluded.has(entry)) continue;
      await copyAsset(resolve(source, entry), resolve(destination, entry));
    }
    return;
  }
  if (!info.isFile() || /\.(?:key|uin|db|sqlite3?|pyc|log)$/iu.test(source))
    return;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

/** Builds trusted plugins, then stages only their explicit package.files assets. */
export async function buildPlugins(
  sourceDirectory: string,
  outputDirectory: string,
  build = true,
): Promise<void> {
  const source = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  if (source === output || inside(source, output) || inside(output, source)) {
    throw new Error(
      "Plugin build output must be separate from plugin sources.",
    );
  }
  const plugins = await discoverAuraPluginDirectories(source);
  // Output is a dedicated build directory supplied by the application, never plugin state.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const plugin of plugins) {
    const manifest: unknown = JSON.parse(
      await readFile(resolve(plugin, "package.json"), "utf8"),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("files" in manifest) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length === 0
    ) {
      throw new Error(
        `Plugin ${relative(source, plugin)} requires package.files for release.`,
      );
    }
    if (
      build &&
      "scripts" in manifest &&
      manifest.scripts &&
      typeof manifest.scripts === "object" &&
      "build" in manifest.scripts
    ) {
      const pnpm = process.env.npm_execpath;
      if (!pnpm) throw new Error("Run plugin builds through pnpm.");
      const nativePnpm = /(?:\.exe|[/\\]pnpm)$/iu.test(pnpm);
      await execute(
        nativePnpm ? pnpm : process.execPath,
        [...(nativePnpm ? [] : [pnpm]), "--dir", plugin, "run", "build"],
        { windowsHide: true },
      );
    }
    const destination = resolve(output, relative(source, plugin));
    const files: unknown[] = [
      "package.json",
      "aura.plugin.json",
      ...manifest.files,
    ];
    for (const file of new Set(files)) {
      if (typeof file !== "string" || /[*?]/u.test(file))
        throw new Error("Plugin files must be explicit relative assets.");
      const asset = resolve(plugin, file);
      const parts = relative(plugin, asset).split(/[\\/]/u);
      if (
        !inside(plugin, asset) ||
        parts.some((part) => part.startsWith(".") || excluded.has(part))
      ) {
        throw new Error(
          "Plugin release asset is outside the allowed package files.",
        );
      }
      await copyAsset(asset, resolve(destination, relative(plugin, asset)));
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const target = process.argv[2];
  if (target !== "server" && target !== "desktop")
    throw new Error("Usage: build-plugins.ts <server|desktop>");
  const output = resolve(
    repositoryRoot,
    "apps",
    target,
    target === "desktop" ? "dist-host/plugins" : "dist/plugins",
  );
  await buildPlugins(resolve(repositoryRoot, "plugins"), output);
  console.log(`Plugin release assets: ${relative(repositoryRoot, output)}`);
}
