import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AuraPluginConfiguration } from "@aura/protocol/types";
import { AuraPluginConfigurationError } from "./types.ts";
import { configSchema } from "./schemas.ts";
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
