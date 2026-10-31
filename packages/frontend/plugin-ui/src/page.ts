import type { Context } from "@deepseek-ai/cordis";
import type { ReactNode } from "react";
import type { JsonValue } from "@aura/protocol/types";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Workbench slot service: plugin client bundles register full pages here. */
    auraWorkbench: AuraWorkbench;
  }
}

/** Props handed to a plugin-contributed workbench page on every render. */
export interface AuraPluginPageProps {
  /** Aura runtime origin, e.g. `http://127.0.0.1:4311`. */
  endpoint: string;
  /** Plugin id of the page, matching the manifest `id`. */
  pluginId: string;
  /**
   * Controlled backend boundary: calls this plugin's own capability provider
   * through the Aura runtime. The provider declares the supported operations;
   * other plugins' capabilities are unreachable.
   */
  invoke(
    capabilityLocalId: string,
    operation: string,
    input?: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  onDirtyChange(dirty: boolean): void;
  onBack(): void;
}

/** One complete workbench page, contributed from a plugin client bundle. */
export interface AuraPluginPageDefinition {
  /** Page-local ID; the canonical ID is `<plugin-id>/<id>`. */
  id: string;
  /** Title shown in navigation and the document head. */
  title: string;
  description?: string;
  /** Lucide icon name; the workbench falls back to a generic icon. */
  icon?: string;
  render(props: AuraPluginPageProps): ReactNode;
}

/** What a result renderer sees: one Flow Run as the workbench shows it. */
export interface AuraPluginResultContext {
  /** Aura runtime origin, e.g. `http://127.0.0.1:4311`. */
  endpoint: string;
  /** Plugin id that registered the renderer. */
  pluginId: string;
  run: {
    id: string;
    flowId: string;
    /** Owning plugin of the Flow, when the Flow came from a plugin. */
    flowPluginId?: string;
    status: string;
    input?: JsonValue;
  };
  /** Run output, or the stored output of a finished Run. */
  output: JsonValue;
}

/**
 * Renders the output area of matching Flow Runs. The workbench asks every
 * registered renderer in registration order and uses the first match; Runs no
 * renderer claims use the generic view. The host never special-cases Flow IDs.
 */
export interface AuraPluginResultDefinition {
  /** Renderer-local ID; the canonical ID is `<plugin-id>/<id>`. */
  id: string;
  /** Cheap, side-effect-free check on the output shape or Run identity. */
  match(context: AuraPluginResultContext): boolean;
  render(context: AuraPluginResultContext): ReactNode;
}

/**
 * Plugin workbench slot service. Registrations happen within the calling
 * fiber and are removed when the plugin unloads.
 */
export interface AuraWorkbench {
  page(definition: AuraPluginPageDefinition): void;
  result(definition: AuraPluginResultDefinition): void;
}

const ownerKey = Symbol.for("aura.plugin-owner");

/** Binds `apply()` to the owning plugin so registrations are namespaced. */
export function pluginOwnerContext(ctx: Context, pluginId: string): Context {
  return ctx.extend({ [ownerKey]: pluginId });
}

export function pluginOwnerOf(ctx: Context): string {
  const owner: unknown = (ctx as unknown as Record<symbol, unknown>)[ownerKey];
  if (typeof owner !== "string")
    throw new Error(
      "plugin-ui: the workbench did not declare the plugin owner",
    );
  return owner;
}

export function validatePageDefinition(
  value: unknown,
): AuraPluginPageDefinition {
  const page = value as AuraPluginPageDefinition | null;
  if (
    !page ||
    typeof page.id !== "string" ||
    !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(page.id) ||
    typeof page.title !== "string" ||
    !page.title.trim() ||
    typeof page.render !== "function"
  )
    throw new Error(
      "plugin-ui: a page needs an id, a non-empty title and render().",
    );
  return {
    id: page.id,
    title: page.title.trim(),
    ...(page.description ? { description: page.description } : {}),
    ...(page.icon ? { icon: page.icon } : {}),
    render: page.render,
  };
}

export function validateResultDefinition(
  value: unknown,
): AuraPluginResultDefinition {
  const result = value as AuraPluginResultDefinition | null;
  if (
    !result ||
    typeof result.id !== "string" ||
    !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(result.id) ||
    typeof result.match !== "function" ||
    typeof result.render !== "function"
  )
    throw new Error("plugin-ui: a result needs an id, match() and render().");
  return { id: result.id, match: result.match, render: result.render };
}

/**
 * Declares a Run result renderer. The client bundle's `apply(ctx)` registers
 * it through `ctx.auraWorkbench.result(...)`.
 */
export function defineResult(
  definition: AuraPluginResultDefinition,
): AuraPluginResultDefinition {
  return validateResultDefinition(definition);
}

/**
 * Declares a complete workbench page. The client bundle's `apply(ctx)` calls
 * `definePage` and registers it through `ctx.auraWorkbench.page(...)`.
 */
export function definePage(
  definition: AuraPluginPageDefinition,
): AuraPluginPageDefinition {
  return validatePageDefinition(definition);
}

export type { Context };
