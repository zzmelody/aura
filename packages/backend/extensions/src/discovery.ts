import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { satisfies } from "semver";
import { z } from "zod";
import type {
  AuraPluginConfiguration,
  AuraPluginIdentity,
} from "@aura/protocol/types";
import {
  AuraPluginConfigurationError,
  type AuraPluginResolution,
  type LoadAuraPluginsOptions,
  type PluginContributionRoot,
} from "./types.ts";
import { readAuraPluginConfiguration } from "./configuration.ts";
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

type ContributionKind = "action" | "flow" | "capability";
const kindLabels: Record<ContributionKind, string> = {
  action: "Action",
  flow: "Flow",
  capability: "Capability",
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

async function validatePlugin(
  configuredPath: string,
  configDirectory: string,
  options: LoadAuraPluginsOptions,
): Promise<{
  identity: AuraPluginIdentity;
  pluginRoot: string;
  capabilities: string[];
  actionRoot?: string;
  flowRoot?: string;
  capabilityRoot?: string;
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
      "aura.plugin.json 不符合 v1 插件规范。",
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
  // Declared capabilities are built-ins only; a plugin's own providers are implicit.
  const supported = new Set(options.supportedCapabilities ?? []);
  const unsupported = manifest.capabilities.filter(
    (item) => !supported.has(item),
  );
  if (unsupported.length)
    throw new AuraPluginConfigurationError(
      `插件请求了未提供的能力：${unsupported.join(", ")}。`,
    );

  const pluginRequire = createRequire(resolve(root, "package.json"));
  let sdkPackage: string;
  try {
    sdkPackage = pluginRequire.resolve("@aura/plugin-sdk/package.json");
    if (manifest.contributes.actions)
      pluginRequire.resolve("@aura/plugin-sdk/action");
    if (manifest.contributes.flows)
      pluginRequire.resolve("@aura/plugin-sdk/flow");
    if (manifest.contributes.capabilities)
      pluginRequire.resolve("@aura/plugin-sdk/capability");
  } catch {
    throw new AuraPluginConfigurationError(
      "插件依赖 @aura/plugin-sdk 未安装或不可解析。",
    );
  }
  const resolvedSdk = z
    .object({ version: z.string() })
    .passthrough()
    .safeParse(await json(sdkPackage, "@aura/plugin-sdk/package.json"));
  if (
    !resolvedSdk.success ||
    !satisfies(resolvedSdk.data.version, manifest.engines.pluginSdk, {
      includePrerelease: true,
    })
  )
    throw new AuraPluginConfigurationError(
      "插件实际解析到的 Plugin SDK 版本不兼容。",
    );

  const identity = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
  };
  const capabilityRoot = manifest.contributes.capabilities
    ? await validateContributionRoot(
        root,
        manifest.contributes.capabilities,
        "capability",
      )
    : undefined;
  // A plugin may always call its own providers; they are granted by ID.
  const own = capabilityRoot
    ? (await readdir(capabilityRoot)).map((local) => `${manifest.id}/${local}`)
    : [];
  return {
    identity,
    pluginRoot: root,
    capabilities: [...manifest.capabilities, ...own.sort()],
    ...(capabilityRoot ? { capabilityRoot } : {}),
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
  };
}

export async function resolveAuraPluginConfiguration(
  configuration: AuraPluginConfiguration,
  options: LoadAuraPluginsOptions,
): Promise<AuraPluginResolution> {
  const result: AuraPluginResolution = {
    actionRoots: [],
    flowRoots: [],
    capabilityRoots: [],
    plugins: [],
  };

  const seen = new Set<string>();
  const directory = dirname(resolve(options.configPath));
  for (const entry of configuration.plugins) {
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
      seen.add(plugin.identity.id);
      const root = (path: string): PluginContributionRoot => ({
        path,
        pluginRoot: plugin.pluginRoot,
        namespace: plugin.identity.id,
        plugin: plugin.identity,
        capabilities: [...plugin.capabilities],
      });
      if (plugin.actionRoot) result.actionRoots.push(root(plugin.actionRoot));
      if (plugin.flowRoot) result.flowRoots.push(root(plugin.flowRoot));
      if (plugin.capabilityRoot)
        result.capabilityRoots.push({
          ...root(plugin.capabilityRoot),
          ...(entry.settings === undefined ? {} : { settings: entry.settings }),
        });
      result.plugins.push({
        ...plugin.identity,
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

/** Resolves explicitly configured trusted plugin directories without executing them. */
export async function loadAuraPlugins(
  options: LoadAuraPluginsOptions,
): Promise<AuraPluginResolution> {
  return resolveAuraPluginConfiguration(
    await readAuraPluginConfiguration(options.configPath),
    options,
  );
}
