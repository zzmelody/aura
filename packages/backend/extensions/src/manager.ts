import { resolve } from "node:path";
import type {
  AuraPluginConfiguration,
  AuraPluginSettingsState,
} from "@aura/protocol/types";
import {
  AuraPluginConfigurationError,
  type AuraPluginResolution,
  type LoadAuraPluginsOptions,
} from "./types.ts";
import {
  readAuraPluginConfiguration,
  writeAuraPluginConfiguration,
} from "./configuration.ts";
import { resolveAuraPluginConfiguration } from "./discovery.ts";
import { settingsUpdateSchema } from "./schemas.ts";
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
    // The settings UI edits paths only; keep each path's plugin-owned settings.
    const stored = await readAuraPluginConfiguration(this.#options.configPath);
    const settingsByPath = new Map(
      stored.plugins.map((entry) => [entry.path, entry.settings]),
    );
    const configuration: AuraPluginConfiguration = {
      version: 1,
      plugins: parsed.data.plugins.map((entry) => {
        const settings = settingsByPath.get(entry.path);
        return {
          path: entry.path,
          enabled: entry.enabled,
          trust: "local",
          ...(settings === undefined ? {} : { settings }),
        };
      }),
    };
    const resolution = await resolveAuraPluginConfiguration(
      configuration,
      this.#options,
    );
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
