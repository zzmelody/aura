import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  AuraPluginConfiguration,
  AuraPluginIdentity,
  AuraPluginSettingsState,
  AuraPluginStatus,
} from "@aura/protocol/types";
import { satisfies, valid, validRange } from "semver";
import { z } from "zod";

const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;
const localIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;

const configEntrySchema = z
  .object({
    path: z.string().trim().min(1).max(4_096),
    enabled: z.boolean(),
    trust: z.literal("local"),
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal(1),
    plugins: z.array(configEntrySchema).max(64),
  })
  .strict();

const settingsUpdateSchema = z
  .object({
    plugins: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(4_096),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(pluginIdPattern),
    name: z.string().trim().min(1).max(80),
    version: z.string().refine((value) => Boolean(valid(value))),
    description: z.string().max(500).optional(),
    homepage: z.string().optional(),
    license: z.string().optional(),
    engines: z
      .object({
        aura: z.string().refine((value) => Boolean(validRange(value))),
        pluginSdk: z.string().refine((value) => Boolean(validRange(value))),
      })
      .strict(),
    contributes: z
      .object({
        actions: z.string().trim().min(1).optional(),
        flows: z.string().trim().min(1).optional(),
      })
      .strict()
      .refine((value) => Boolean(value.actions || value.flows)),
    capabilities: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export interface PluginContributionRoot {
  path: string;
  namespace: string;
  plugin: AuraPluginIdentity;
  capabilities: string[];
}

export interface AuraPluginResolution {
  actionRoots: PluginContributionRoot[];
  flowRoots: PluginContributionRoot[];
  plugins: AuraPluginStatus[];
}

export interface LoadAuraPluginsOptions {
  configPath: string;
  auraVersion: string;
  pluginSdkVersion: string;
  supportedCapabilities?: readonly string[];
}

export class AuraPluginConfigurationError extends Error {}

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

async function contributionEntries(
  directory: string,
  kind: "action" | "flow",
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
  kind: "action" | "flow",
): Promise<string> {
  let root: string;
  try {
    root = await realpath(resolve(pluginRoot, configuredPath));
  } catch {
    throw new AuraPluginConfigurationError(
      `${kind === "action" ? "Action" : "Flow"} 贡献目录不存在。`,
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
  capabilities: string[];
  actionRoot?: string;
  flowRoot?: string;
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
  return {
    identity,
    capabilities: [...manifest.capabilities],
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

function parseConfiguration(
  source: unknown,
  label = "plugins.json",
): AuraPluginConfiguration {
  const parsed = configSchema.safeParse(source);
  if (!parsed.success)
    throw new AuraPluginConfigurationError(
      `${label} 不符合 Aura 插件配置 v1。`,
    );
  return parsed.data;
}

/** Reads the persisted plugin roots. A missing file is the valid empty state. */
export async function readAuraPluginConfiguration(
  configPath: string,
): Promise<AuraPluginConfiguration> {
  let content: string;
  try {
    content = await readFile(resolve(configPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, plugins: [] };
    throw new AuraPluginConfigurationError("plugins.json 不可访问。");
  }
  try {
    return parseConfiguration(JSON.parse(content) as unknown);
  } catch (error) {
    if (error instanceof AuraPluginConfigurationError) throw error;
    throw new AuraPluginConfigurationError(
      "plugins.json 不是有效的 UTF-8 JSON。",
    );
  }
}

/** Replaces only Aura's fixed plugin configuration file via a same-directory rename. */
export async function writeAuraPluginConfiguration(
  configPath: string,
  configuration: AuraPluginConfiguration,
): Promise<void> {
  const parsed = parseConfiguration(configuration, "插件配置");
  const target = resolve(configPath);
  const directory = dirname(target);
  const temporary = resolve(
    directory,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
  } catch {
    throw new AuraPluginConfigurationError("插件配置保存失败。");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveAuraPluginConfiguration(
  configuration: AuraPluginConfiguration,
  options: LoadAuraPluginsOptions,
): Promise<AuraPluginResolution> {
  const result: AuraPluginResolution = {
    actionRoots: [],
    flowRoots: [],
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
        namespace: plugin.identity.id,
        plugin: plugin.identity,
        capabilities: [...plugin.capabilities],
      });
      if (plugin.actionRoot) result.actionRoots.push(root(plugin.actionRoot));
      if (plugin.flowRoot) result.flowRoots.push(root(plugin.flowRoot));
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

function signature(value: unknown): string {
  return JSON.stringify(value);
}

/** Owns startup resolution plus safe read/replace operations for the settings API. */
export class AuraPluginManager {
  resolution: AuraPluginResolution;
  readonly #options: LoadAuraPluginsOptions;
  #activeConfiguration: AuraPluginConfiguration;
  #activate?: (resolution: AuraPluginResolution) => Promise<void>;
  #operations: Promise<unknown> = Promise.resolve();

  private constructor(
    options: LoadAuraPluginsOptions,
    configuration: AuraPluginConfiguration,
    resolution: AuraPluginResolution,
  ) {
    this.#options = options;
    this.#activeConfiguration = configuration;
    this.resolution = resolution;
  }

  static async create(options: LoadAuraPluginsOptions) {
    const configuration = await readAuraPluginConfiguration(options.configPath);
    const resolution = await resolveAuraPluginConfiguration(
      configuration,
      options,
    );
    return new AuraPluginManager(options, configuration, resolution);
  }

  /** Connects the manager to the live orchestration host before exposing the API. */
  setActivator(
    activate: (resolution: AuraPluginResolution) => Promise<void>,
  ): void {
    this.#activate = activate;
  }

  private async currentSettings(): Promise<AuraPluginSettingsState> {
    const configuration = await readAuraPluginConfiguration(
      this.#options.configPath,
    );
    const preview = await resolveAuraPluginConfiguration(
      configuration,
      this.#options,
    );
    return {
      configPath: resolve(this.#options.configPath),
      plugins: configuration.plugins.map((entry, index) => ({
        ...entry,
        status: preview.plugins[index] ?? {
          name: "本地 Aura 插件",
          enabled: entry.enabled,
          available: false,
          error: "插件状态不可用。",
        },
      })),
      active: this.resolution.plugins,
      applyRequired:
        signature(configuration) !== signature(this.#activeConfiguration) ||
        signature(preview.plugins) !== signature(this.resolution.plugins),
    };
  }

  async settings(): Promise<AuraPluginSettingsState> {
    await this.#operations;
    return this.currentSettings();
  }

  private async replaceSettings(
    source: unknown,
  ): Promise<AuraPluginSettingsState> {
    const parsed = settingsUpdateSchema.safeParse(source);
    if (!parsed.success)
      throw new AuraPluginConfigurationError(
        "插件目录设置不符合 Aura 配置规则。",
      );
    const configuration: AuraPluginConfiguration = {
      version: 1,
      plugins: parsed.data.plugins.map((entry) => ({
        path: entry.path,
        enabled: entry.enabled,
        trust: "local",
      })),
    };
    const resolution = await resolveAuraPluginConfiguration(
      configuration,
      this.#options,
    );
    const previousConfiguration = this.#activeConfiguration;
    const previousResolution = this.resolution;

    try {
      await this.#activate?.(resolution);
    } catch {
      throw new AuraPluginConfigurationError(
        "插件加载失败，当前运行配置保持不变。",
      );
    }
    try {
      await writeAuraPluginConfiguration(
        this.#options.configPath,
        configuration,
      );
    } catch (error) {
      if (this.#activate) {
        try {
          await this.#activate(previousResolution);
        } catch {
          throw new AuraPluginConfigurationError(
            "插件配置保存失败，且运行时回滚失败，请重新保存当前配置。",
          );
        }
      }
      throw error;
    }
    this.#activeConfiguration = configuration;
    this.resolution = resolution;
    return this.currentSettings();
  }

  async updateSettings(source: unknown): Promise<AuraPluginSettingsState> {
    const task = this.#operations.then(() => this.replaceSettings(source));
    this.#operations = task.catch(() => undefined);
    return task;
  }
}
