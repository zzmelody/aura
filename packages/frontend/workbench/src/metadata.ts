import { language, registerCatalogs, messageText } from "@aura/i18n/runtime";
import { apiErrorText } from "./api-error-messages.ts";
import {
  isPluginLocalization,
  type PluginLocalization,
  type SchemaTextKeys,
} from "@aura/protocol/localization";
import type {
  AuraPluginSettingsState,
  AuraPluginStatus,
  FlowCatalog,
  FlowCatalogEntry,
  JsonValue,
} from "@aura/protocol/types";

type Runtime = typeof language.i18n;
export function flowCatalogError(
  entry?: FlowCatalogEntry,
  runtime: Runtime = language.i18n,
): string | undefined {
  return entry?.error
    ? messageText(apiErrorText(entry.errorDetails, entry.error), runtime)
    : undefined;
}
type TextKeys = SchemaTextKeys & { nameKey?: string };
interface Binding {
  namespace: string;
  keys: TextKeys;
  runtime: Runtime;
}
// Bindings are presentation-only. JSON serialization retains the original metadata/schema.
const bindings = new WeakMap<object, Binding>();
let ownerSequence = 0;

function pointerNode(root: JsonValue, pointer: string): object | undefined {
  let node: JsonValue | undefined = root;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return;
    node = (node as Record<string, JsonValue>)[key];
  }
  return node && typeof node === "object" ? node : undefined;
}

function bindSchema(
  schema: JsonValue | undefined,
  keys: Record<string, SchemaTextKeys> | undefined,
  namespace: string,
  runtime: Runtime,
): JsonValue | undefined {
  if (!schema || !keys) return schema;
  const copy = structuredClone(schema);
  for (const [pointer, messages] of Object.entries(keys)) {
    const node = pointerNode(copy, pointer);
    if (node) bindings.set(node, { namespace, keys: messages, runtime });
  }
  return copy;
}

/** One owner per catalog/settings reader, so endpoints and concurrent views cannot collide. */
export class MetadataOwner {
  private readonly scope = `metadata.${++ownerSequence}`;
  private readonly runtime: Runtime;
  private live = true;
  private readonly resources = new Map<
    string,
    {
      fingerprint: string;
      namespace: string;
      metadata: PluginLocalization;
      dispose(): void;
    }
  >();

  constructor(runtime: Runtime = language.i18n) {
    this.runtime = runtime;
  }

  get active(): boolean {
    return this.live;
  }
  activate(): void {
    this.live = true;
  }

  private update(plugins: readonly AuraPluginStatus[]): void {
    const present = new Set<string>();
    for (const plugin of plugins) {
      if (
        !plugin.id ||
        !isPluginLocalization(plugin.localization) ||
        present.has(plugin.id)
      )
        continue;
      present.add(plugin.id);
      const fingerprint = JSON.stringify(plugin.localization);
      if (this.resources.get(plugin.id)?.fingerprint === fingerprint) continue;
      const namespace = `${this.scope}.${plugin.id}`;
      this.resources.set(plugin.id, {
        namespace,
        fingerprint,
        metadata: plugin.localization,
        dispose: registerCatalogs(
          namespace,
          plugin.localization.catalogs,
          this.runtime,
        ),
      });
    }
    for (const [id, resource] of this.resources) {
      if (present.has(id)) continue;
      resource.dispose();
      this.resources.delete(id);
    }
  }

  private plugin(plugin: AuraPluginStatus): AuraPluginStatus {
    const resource = plugin.id ? this.resources.get(plugin.id) : undefined;
    if (!resource) return plugin;
    const copy = { ...plugin };
    bindings.set(copy, {
      namespace: resource.namespace,
      keys: resource.metadata,
      runtime: this.runtime,
    });
    return copy;
  }

  private contribution(
    entry: FlowCatalogEntry,
    kind: "flows" | "actions",
  ): FlowCatalogEntry {
    // Registered plugin identity is authoritative, including explicitly granted legacy IDs.
    const pluginId = entry.plugin?.id;
    if (!pluginId) return entry;
    const resource = this.resources.get(pluginId);
    const localId = entry.id.startsWith(`${pluginId}/`)
      ? entry.id.slice(pluginId.length + 1)
      : entry.id;
    const keys = resource?.metadata[kind]?.[localId];
    if (!resource || !keys) return entry;
    const copy = {
      ...entry,
      ...(entry.inputSchema === undefined
        ? {}
        : {
            inputSchema: bindSchema(
              entry.inputSchema,
              keys.input,
              resource.namespace,
              this.runtime,
            ),
          }),
      ...(entry.outputSchema === undefined
        ? {}
        : {
            outputSchema: bindSchema(
              entry.outputSchema,
              keys.output,
              resource.namespace,
              this.runtime,
            ),
          }),
    };
    bindings.set(copy, {
      namespace: resource.namespace,
      keys,
      runtime: this.runtime,
    });
    return copy;
  }

  catalog(catalog: FlowCatalog): FlowCatalog {
    if (!this.live) return catalog;
    this.update(catalog.plugins ?? []);
    return {
      ...catalog,
      flows: catalog.flows.map((entry) => this.contribution(entry, "flows")),
      ...(catalog.actions
        ? {
            actions: catalog.actions.map((entry) =>
              this.contribution(entry, "actions"),
            ),
          }
        : {}),
      ...(catalog.plugins
        ? { plugins: catalog.plugins.map((plugin) => this.plugin(plugin)) }
        : {}),
    };
  }

  settings(state: AuraPluginSettingsState): AuraPluginSettingsState {
    if (!this.live) return state;
    this.update(state.plugins.map((entry) => entry.status));
    return {
      ...state,
      plugins: state.plugins.map((entry) => ({
        ...entry,
        status: this.plugin(entry.status),
      })),
    };
  }

  dispose(): void {
    this.live = false;
    for (const resource of this.resources.values()) resource.dispose();
    this.resources.clear();
  }
}

function translate(
  binding: Binding | undefined,
  key: string | undefined,
  fallback: string,
  runtime: Runtime,
): string {
  return binding && key
    ? runtime.t(key, {
        ns: binding.namespace,
        defaultValue: fallback,
        skipInterpolation: true,
      })
    : fallback;
}

/** Resolve only at render/search time; original values remain suitable for persistence and AI. */
export function metadataText(
  target: object | undefined,
  field: "name" | "title" | "description" | "placeholder",
  fallback: string,
  runtime?: Runtime,
): string {
  const binding = target ? bindings.get(target) : undefined;
  return translate(
    binding,
    binding?.keys[`${field}Key`],
    fallback,
    runtime ?? binding?.runtime ?? language.i18n,
  );
}

export function metadataEnumLabel(
  schema: object,
  index: number,
  fallback: string,
  runtime?: Runtime,
): string {
  const binding = bindings.get(schema);
  return translate(
    binding,
    binding?.keys.enumKeys?.[index],
    fallback,
    runtime ?? binding?.runtime ?? language.i18n,
  );
}

export const flowTitle = (flow: FlowCatalogEntry, runtime?: Runtime): string =>
  metadataText(flow, "title", flow.title, runtime);
export const flowDescription = (
  flow: FlowCatalogEntry,
  runtime?: Runtime,
): string => metadataText(flow, "description", flow.description, runtime);
