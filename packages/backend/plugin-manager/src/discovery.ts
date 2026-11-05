import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { satisfies } from "semver";
import { z } from "zod";
import type {
  AuraPluginConfiguration,
  AuraPluginIdentity,
  PluginCompatibility,
  PluginHttpContribution,
} from "@aura/protocol/types";
import {
  AuraPluginConfigurationError,
  type AuraPluginResolution,
  type LoadAuraPluginsOptions,
  type PluginContributionRoot,
} from "./types.ts";
import { readAuraPluginConfiguration } from "./configuration.ts";
import { resolveAuraPluginEntries } from "./directories.ts";
import { manifestSchema, localIdPattern } from "./schemas.ts";
async function json(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new AuraPluginConfigurationError(`${label} 不是有效的 UTF-8 JSON。`);
  }
}

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

type ContributionKind = "action" | "flow";
const kindLabels: Record<ContributionKind, string> = {
  action: "Action",
  flow: "Flow",
};

async function contributionEntries(
  directory: string,
  kind: ContributionKind,
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory())
      result.push(...(await contributionEntries(path, kind)));
    else if (entry.isFile() && entry.name.endsWith(`.${kind}.js`))
      result.push(path);
  }
  return result;
}

/**
 * Locates a prebuilt entry file the manifest declares (page bundle, backend
 * module or HTTP adapter). The file must sit inside the plugin root and stay
 * readable; Aura never builds or transpiles plugin code at discovery time.
 */
async function validateEntryFile(
  pluginRoot: string,
  configuredPath: string,
  label: string,
): Promise<string> {
  let entry: string;
  try {
    entry = await realpath(resolve(pluginRoot, configuredPath));
  } catch {
    throw new AuraPluginConfigurationError(`${label}不存在。`);
  }
  if (entry === pluginRoot || !inside(pluginRoot, entry))
    throw new AuraPluginConfigurationError(`${label}必须位于插件根目录内。`);
  const info = await stat(entry);
  if (!info.isFile() || info.size === 0)
    throw new AuraPluginConfigurationError(`${label}必须是非空文件。`);
  return entry;
}

async function validateContributionRoot(
  pluginRoot: string,
  configuredPath: string,
  kind: ContributionKind,
): Promise<string> {
  let root: string;
  try {
    root = await realpath(resolve(pluginRoot, configuredPath));
  } catch {
    throw new AuraPluginConfigurationError(
      `${kindLabels[kind]} 贡献目录不存在。`,
    );
  }
  if (root === pluginRoot || !inside(pluginRoot, root))
    throw new AuraPluginConfigurationError(
      "插件贡献目录必须位于插件根目录内。",
    );
  const children = await readdir(root, { withFileTypes: true });
  if (children.some((entry) => !entry.isDirectory()))
    throw new AuraPluginConfigurationError("贡献根目录只能包含直接贡献目录。");
  for (const child of children) {
    if (!localIdPattern.test(child.name))
      throw new AuraPluginConfigurationError(
        `无效的本地贡献 ID：${child.name}`,
      );
    const directory = resolve(root, child.name);
    const expected = resolve(directory, `${child.name}.${kind}.js`);
    const entries = await contributionEntries(directory, kind);
    if (entries.length !== 1 || entries[0] !== expected)
      throw new AuraPluginConfigurationError(
        `${child.name} 必须且只能包含入口 ${child.name}.${kind}.js。`,
      );
  }
  return root;
}

async function validatePresetRoot(root: string, path: string) {
  const target = await realpath(resolve(root, path));
  if (
    target === root ||
    !inside(root, target) ||
    !(await stat(target)).isDirectory()
  )
    throw new AuraPluginConfigurationError(
      "Preset root must be inside the plugin.",
    );
  return target;
}
async function validatePlugin(
  configuredPath: string,
  configDirectory: string,
  options: LoadAuraPluginsOptions,
): Promise<{
  identity: AuraPluginIdentity;
  description?: string;
  pluginRoot: string;
  permissions: string[];
  actionRoot?: string;
  flowRoot?: string;
  /** Absolute path of the built backend module, when the plugin has one. */
  backendEntry?: string;
  /** Absolute path of the built browser bundle, when the plugin contributes pages. */
  pageBundle?: string;
  compatibility?: PluginCompatibility;
  http?: PluginHttpContribution;
  presets?: string;
}> {
  let root: string;
  try {
    root = await realpath(resolve(configDirectory, configuredPath));
  } catch {
    throw new AuraPluginConfigurationError("插件目录不存在或不可访问。");
  }
  const manifestResult = manifestSchema.safeParse(
    await json(resolve(root, "aura.plugin.json"), "aura.plugin.json"),
  );
  if (!manifestResult.success)
    throw new AuraPluginConfigurationError(
      "aura.plugin.json 不符合 v2 插件规范。",
    );
  const manifest = manifestResult.data;
  const packageResult = z
    .object({ type: z.unknown().optional() })
    .passthrough()
    .safeParse(await json(resolve(root, "package.json"), "package.json"));
  if (!packageResult.success || packageResult.data.type !== "module")
    throw new AuraPluginConfigurationError(
      'package.json 必须声明 "type": "module"。',
    );
  if (
    !satisfies(options.auraVersion, manifest.engines.aura, {
      includePrerelease: true,
    })
  )
    throw new AuraPluginConfigurationError(
      `插件不支持 Aura ${options.auraVersion}。`,
    );
  if (
    !satisfies(options.pluginSdkVersion, manifest.engines.pluginSdk, {
      includePrerelease: true,
    })
  )
    throw new AuraPluginConfigurationError(
      `插件不支持 Plugin SDK ${options.pluginSdkVersion}。`,
    );
  const supported = new Set(options.supportedPermissions ?? []);
  const unsupported = manifest.permissions.filter(
    (item) => !supported.has(item),
  );
  if (unsupported.length)
    throw new AuraPluginConfigurationError(
      `插件请求了未提供的权限：${unsupported.join(", ")}。`,
    );

  // `@aura/plugin-sdk` is provided by the host at load time; plugins never
  // install it. The `engines.pluginSdk` check above is the whole contract.

  const identity = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
  };
  const backendEntry = manifest.contributes.backend
    ? await validateEntryFile(root, manifest.contributes.backend, "后端入口")
    : undefined;
  for (const [kind, path] of [
    ["actions", manifest.contributes.actions],
    ["flows", manifest.contributes.flows],
  ] as const) {
    for (const local of Object.keys(manifest.compatibility?.[kind] ?? {})) {
      if (
        !path ||
        !(
          await stat(resolve(root, path, local)).catch(() => undefined)
        )?.isDirectory()
      )
        throw new AuraPluginConfigurationError(
          "Legacy contribution grant has no matching entry.",
        );
    }
  }
  if (
    (manifest.contributes.http || manifest.contributes.presets) &&
    !backendEntry
  )
    throw new AuraPluginConfigurationError(
      "Backend HTTP/presets require contributes.backend.",
    );
  return {
    identity,
    ...(manifest.description ? { description: manifest.description } : {}),
    pluginRoot: root,
    ...(manifest.compatibility
      ? { compatibility: manifest.compatibility }
      : {}),
    ...(manifest.contributes.http
      ? {
          http: {
            entry: await validateEntryFile(
              root,
              manifest.contributes.http.entry,
              "HTTP 入口",
            ),
            mounts: manifest.contributes.http.mounts,
          },
        }
      : {}),
    ...(manifest.contributes.presets
      ? {
          presets: await validatePresetRoot(root, manifest.contributes.presets),
        }
      : {}),
    permissions: [...manifest.permissions],
    ...(backendEntry ? { backendEntry } : {}),
    ...(manifest.contributes.actions
      ? {
          actionRoot: await validateContributionRoot(
            root,
            manifest.contributes.actions,
            "action",
          ),
        }
      : {}),
    ...(manifest.contributes.flows
      ? {
          flowRoot: await validateContributionRoot(
            root,
            manifest.contributes.flows,
            "flow",
          ),
        }
      : {}),
    ...(manifest.contributes.pages
      ? {
          pageBundle: await validateEntryFile(
            root,
            manifest.contributes.pages,
            "页面贡献的浏览器入口",
          ),
        }
      : {}),
  };
}

export async function resolveAuraPluginConfiguration(
  configuration: AuraPluginConfiguration,
  options: LoadAuraPluginsOptions,
): Promise<AuraPluginResolution> {
  const result: AuraPluginResolution = {
    actionRoots: [],
    flowRoots: [],
    backendRoots: [],
    pageRoots: [],
    plugins: [],
  };

  const seen = new Set<string>();
  const claimed = new Set<string>();
  const directory = dirname(resolve(options.configPath));
  const effective = await resolveAuraPluginEntries(configuration, options);
  for (const entry of effective.plugins) {
    if (!entry.enabled) {
      result.plugins.push({
        name: "已禁用的本地插件",
        enabled: false,
        available: false,
      });
      continue;
    }
    try {
      const plugin = await validatePlugin(entry.path, directory, options);
      if (seen.has(plugin.identity.id))
        throw new AuraPluginConfigurationError(
          `插件 ID 重复：${plugin.identity.id}。`,
        );
      const claims = [
        ...Object.keys(plugin.compatibility?.flows ?? {}).map(
          (id) => `flow:${id}`,
        ),
        ...Object.keys(plugin.compatibility?.actions ?? {}).map(
          (id) => `action:${id}`,
        ),
        ...(plugin.compatibility?.presets ?? []).map((id) => `preset:${id}`),
        ...(plugin.compatibility?.storageDomains ?? []).map(
          (id) => `domain:${id}`,
        ),
        ...(plugin.compatibility?.directories ?? []).map(
          (id) => `directory:${id}`,
        ),
        ...(plugin.compatibility?.rpcPrefixes ?? []).map((id) => `rpc:${id}`),
        ...(plugin.http?.mounts ?? []).map((id) => `http:${id}`),
      ];
      if (claims.some((claim) => claimed.has(claim)))
        throw new AuraPluginConfigurationError(
          "Plugin compatibility grant is already owned.",
        );
      for (const claim of claims) claimed.add(claim);
      seen.add(plugin.identity.id);
      const root = (path: string): PluginContributionRoot => ({
        path,
        pluginRoot: plugin.pluginRoot,
        namespace: plugin.identity.id,
        plugin: plugin.identity,
        permissions: [...plugin.permissions],
        ...(plugin.compatibility
          ? { compatibility: plugin.compatibility }
          : {}),
        ...(plugin.http ? { http: plugin.http } : {}),
        ...(plugin.presets ? { presets: plugin.presets } : {}),
      });
      if (plugin.actionRoot) result.actionRoots.push(root(plugin.actionRoot));
      if (plugin.flowRoot) result.flowRoots.push(root(plugin.flowRoot));
      if (plugin.backendEntry)
        result.backendRoots.push({
          ...root(plugin.backendEntry),
          ...(entry.settings === undefined ? {} : { settings: entry.settings }),
        });
      if (plugin.pageBundle)
        result.pageRoots.push({
          pluginRoot: plugin.pluginRoot,
          bundlePath: plugin.pageBundle,
          plugin: plugin.identity,
        });
      result.plugins.push({
        ...plugin.identity,
        ...(plugin.description ? { description: plugin.description } : {}),
        enabled: true,
        available: true,
      });
    } catch (error) {
      result.plugins.push({
        name: "本地 Aura 插件",
        enabled: true,
        available: false,
        error:
          error instanceof AuraPluginConfigurationError
            ? error.message
            : "插件校验失败。",
      });
    }
  }
  return result;
}

/** Resolves default and explicitly configured trusted plugins without executing them. */
export async function loadAuraPlugins(
  options: LoadAuraPluginsOptions,
): Promise<AuraPluginResolution> {
  return resolveAuraPluginConfiguration(
    await readAuraPluginConfiguration(options.configPath),
    options,
  );
}
