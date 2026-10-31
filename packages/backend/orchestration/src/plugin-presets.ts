import type { Context } from "@deepseek-ai/cordis";
import {
  entryListProblem,
  type PresetDefinition,
} from "@deepseek-ai/dsh-agent-preset-registry";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parse } from "yaml";
import type { BackendRoot } from "./types.ts";

/** Plugin preset declarations use the same DSH registry and retained Agent revisions. */
export class PluginPresets {
  private readonly registry: Context["agentPresets"];
  private readonly definitions = new Map<
    string,
    { source: string; definition: PresetDefinition; close: () => Promise<void> }
  >();
  constructor(registry: Context["agentPresets"]) {
    this.registry = registry;
  }
  async replace(roots: readonly BackendRoot[]) {
    const desired = new Map<
      string,
      { source: string; definition: PresetDefinition }
    >();
    for (const root of roots) {
      if (!root.presets || !root.plugin) continue;
      for (const entry of await readdir(root.presets, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const directory = await realpath(join(root.presets, entry.name));
        const suffix = relative(root.pluginRoot!, directory);
        if (suffix.startsWith("..") || isAbsolute(suffix))
          throw new Error("plugin_preset_forbidden");
        const id = root.compatibility?.presets?.includes(entry.name)
          ? entry.name
          : `${root.plugin.id}/${entry.name}`;
        const source = await readFile(
          join(directory, "agent.cordis.yml"),
          "utf8",
        );
        const plugins: unknown = parse(source);
        const problem = entryListProblem(plugins, id);
        if (problem) throw new Error(problem);
        const meta = await readFile(join(directory, "preset.yml"), "utf8");
        const field = (key: string) =>
          new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(meta)?.[1];
        if (desired.has(id)) throw new Error("plugin_preset_conflict");
        desired.set(id, {
          source: source + meta,
          definition: {
            id,
            name: field("name"),
            description: field("description"),
            plugins: plugins as PresetDefinition["plugins"],
          },
        });
      }
    }
    const before = new Map(this.definitions);
    const apply = async (wanted: typeof desired) => {
      for (const [id, existing] of this.definitions) {
        if (wanted.get(id)?.source === existing.source) continue;
        await existing.close();
        this.definitions.delete(id);
      }
      for (const [id, item] of wanted) {
        if (this.definitions.has(id)) continue;
        const close = await this.registry.register(item.definition);
        this.definitions.set(id, { ...item, close });
      }
    };
    try {
      await apply(desired);
    } catch (error) {
      await apply(before);
      throw error;
    }
  }
  async close() {
    for (const item of this.definitions.values()) await item.close();
    this.definitions.clear();
  }
}
