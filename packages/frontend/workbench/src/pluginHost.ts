import {
  installSecretMask,
  SECRET_MASK_MODULE,
} from "./features/coding/secret-mask.ts";
import { Context, Service } from "@deepseek-ai/cordis";
import {
  errorMessage,
  MessageError,
  pluginNamespace,
  registerCatalogs,
  type MessageReference,
  type TranslationCatalogs,
} from "@aura/i18n/runtime";
import * as pluginUi from "@aura/plugin-ui";
import {
  pluginOwnerContext,
  pluginOwnerOf,
  validatePageDefinition,
  validateResultDefinition,
  type AuraPluginPageDefinition,
  type AuraPluginResultDefinition,
  type AuraWorkbench,
} from "@aura/plugin-ui";
import type { JsonValue } from "@aura/protocol/types";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as workbenchTransport from "./plugin-transport.ts";
import { PluginHostLifecycle } from "./pluginHostLifecycle.ts";
import { pluginMessage } from "./plugin-messages.ts";
import {
  invokePluginPage,
  LOADER_ID,
  readPluginGraph,
  watchPluginGraph,
  type PluginPageGraph,
} from "./pluginPages.ts";

export interface RegisteredPage {
  pluginId: string;
  definition: AuraPluginPageDefinition;
}

export interface RegisteredResult {
  pluginId: string;
  definition: AuraPluginResultDefinition;
}

export interface PluginFailure {
  id: string;
  message: string | MessageReference;
}

export interface HostHandle {
  pages: Map<string, RegisteredPage>;
  /** Insertion order is registration order; the first match wins. */
  results: Map<string, RegisteredResult>;
  failures: PluginFailure[];
  close(): Promise<void>;
}

/** Public surface of DSH's browser `ClientModuleSystem` that Aura drives. */
interface ClientModuleSystem {
  import(specifier: string): Promise<unknown>;
  prefetch(id: string): Promise<void>;
  invalidate(id: string, rev?: string): void;
}

interface ClientModulesBootstrap {
  createClientModuleSystem(
    target: ClientModuleLoaderTarget,
    bootstrap: { id: string; exports: ClientModulesBootstrap },
    options: {
      boot: PluginPageGraph;
      staticModules: Record<string, unknown>;
      loadBundle?: (url: string) => Promise<void>;
    },
  ): ClientModuleSystem;
  parseBootManifest(wire: unknown): unknown;
}

interface ClientBundleRegistration {
  id: string;
  chunk?: string;
  factory: (require: (specifier: string) => unknown) => unknown;
}

/** DSH's `window.__ModuleLoader__` facade (queue until the system exists). */
interface ClientModuleLoaderTarget {
  mode: "queue" | "live";
  pendingQueue: ClientBundleRegistration[];
  load(registration: ClientBundleRegistration): void;
}

declare global {
  interface Window {
    __ModuleLoader__?: ClientModuleLoaderTarget;
  }
}

interface ClientPlugin {
  name?: string;
  inject: string[];
  apply: (ctx: Context) => void | Promise<void>;
}

function runtimeHref(endpoint: string, url: string): string {
  return new URL(url, endpoint.endsWith("/") ? endpoint : `${endpoint}/`).href;
}

/** Classic same-document script, which is how DSH bundles register factories. */
function loadScript(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = href;
    script.async = false;
    script.dataset.auraPluginBundle = "";
    const timeout = setTimeout(() => {
      script.remove();
      reject(new MessageError(pluginMessage("scriptTimeout")));
    }, 20_000);
    script.onload = () => {
      clearTimeout(timeout);
      script.remove();
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      reject(new MessageError(pluginMessage("scriptLoadFailed")));
    };
    document.head.append(script);
  });
}

/** Accepts DSH's client face (`apply`/`inject` exports) or an ESM default. */
export function pluginExports(value: unknown): ClientPlugin {
  const module = value as { default?: unknown } & Partial<ClientPlugin>;
  const candidate =
    typeof module?.apply === "function"
      ? module
      : (module?.default as Partial<ClientPlugin> | undefined);
  if (!candidate || typeof candidate.apply !== "function")
    throw new MessageError(pluginMessage("missingApply"));
  return {
    ...(candidate.name ? { name: candidate.name } : {}),
    inject: [...new Set(["auraWorkbench", ...(candidate.inject ?? [])])],
    apply: candidate.apply,
  };
}

/** Builds the workbench slot service over the page and result tables. */
function workbenchPages(
  pages: Map<string, RegisteredPage>,
  results: Map<string, RegisteredResult>,
) {
  return class WorkbenchPages extends Service implements AuraWorkbench {
    constructor(ctx: Context) {
      super(ctx, "auraWorkbench");
    }

    translations(catalogs: TranslationCatalogs) {
      const namespace = pluginNamespace(pluginOwnerOf(this.ctx));
      this.ctx.effect(
        () => registerCatalogs(namespace, catalogs),
        `plugin-translations:${namespace}`,
      );
    }

    /** `this.ctx` is the calling plugin's context, so cleanup follows its fiber. */
    page(definition: AuraPluginPageDefinition) {
      const pluginId = pluginOwnerOf(this.ctx);
      const page = validatePageDefinition(definition);
      const id = `${pluginId}/${page.id}`;
      if (pages.has(id))
        throw new MessageError(pluginMessage("duplicatePage", { id }));
      this.ctx.effect(() => {
        pages.set(id, { pluginId, definition: page });
        return () => {
          pages.delete(id);
        };
      }, `plugin-page:${id}`);
    }

    result(definition: AuraPluginResultDefinition) {
      const pluginId = pluginOwnerOf(this.ctx);
      const result = validateResultDefinition(definition);
      const id = `${pluginId}/${result.id}`;
      if (results.has(id))
        throw new MessageError(pluginMessage("duplicateResult", { id }));
      this.ctx.effect(() => {
        results.set(id, { pluginId, definition: result });
        return () => {
          results.delete(id);
        };
      }, `plugin-result:${id}`);
    }
  };
}

/** Platform singletons seeded into DSH's module table; bundles must not ship them. */
function staticModules(workbenchModule?: unknown): Record<string, unknown> {
  return {
    react: React,
    "react/jsx-runtime": ReactJsxRuntime,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    "@deepseek-ai/cordis": { Context, Service },
    "@aura/plugin-ui": pluginUi,
    "@aura/workbench/plugin": workbenchModule ?? {},
    "@aura/workbench/transport": workbenchTransport,
  };
}

function removeOwnedStyles(id: string) {
  document.querySelectorAll("style[data-plugin]").forEach((element) => {
    if (element.getAttribute("data-plugin") === id) element.remove();
  });
}

/**
 * Boots DSH's browser `ClientModuleSystem` against the runtime's combo route
 * and mounts each plugin's client `apply(ctx)` in a Cordis tree that owns the
 * workbench page slot. Aura reconciles entries itself: DSH's `ClientEntries`
 * needs the vendored browser Cordis Loader, which DSH does not publish.
 */
export async function startPluginHost(
  endpoint: string,
  onChange: () => void,
  workbenchModule?: unknown,
): Promise<HostHandle> {
  return lifecycle.start(() =>
    bootPluginHost(endpoint, onChange, workbenchModule),
  );
}

const lifecycle = new PluginHostLifecycle<HostHandle>();

async function bootPluginHost(
  endpoint: string,
  onChange: () => void,
  workbenchModule?: unknown,
): Promise<HostHandle> {
  if (window.__ModuleLoader__)
    throw new MessageError(pluginMessage("alreadyStarted"));
  const pages = new Map<string, RegisteredPage>();
  const results = new Map<string, RegisteredResult>();
  const failures: PluginFailure[] = [];
  const fibers = new Map<string, { dispose(): Promise<unknown> }>();
  const revisions = new Map<string, string>();
  const root = new Context();
  await root.plugin(workbenchPages(pages, results)).await();

  const facade: ClientModuleLoaderTarget = {
    mode: "queue",
    pendingQueue: [],
    load(registration) {
      this.pendingQueue.push(registration);
    },
  };
  window.__ModuleLoader__ = facade;

  try {
    const graph = await readPluginGraph(endpoint, AbortSignal.timeout(20_000));
    const loaderRow = graph.entries.find((row) => row.id === LOADER_ID);
    if (!loaderRow) throw new MessageError(pluginMessage("loaderUnavailable"));
    await loadScript(runtimeHref(endpoint, loaderRow.url));
    const index = facade.pendingQueue.findIndex(
      (registration) => registration.id === LOADER_ID,
    );
    if (index < 0) throw new MessageError(pluginMessage("loaderUnregistered"));
    const [bootstrap] = facade.pendingQueue.splice(index, 1);
    const loader = bootstrap!.factory((specifier) => {
      throw new MessageError(
        pluginMessage("loaderBeforeStartup", { specifier }),
      );
    }) as ClientModulesBootstrap;
    const bundleFailures = new Map<string, string | MessageReference>();
    const modules = loader.createClientModuleSystem(
      facade,
      { id: bootstrap!.id, exports: loader },
      {
        boot: graph,
        staticModules: staticModules(workbenchModule),
        loadBundle: async (url) => {
          try {
            await loadScript(runtimeHref(endpoint, url));
            bundleFailures.delete(url);
          } catch (error) {
            bundleFailures.set(url, errorMessage(error));
            throw error;
          }
        },
      },
    );
    const loadCandidate = async (id: string) => {
      bundleFailures.clear();
      try {
        await modules.prefetch(id);
        return pluginExports(await modules.import(id));
      } catch (error) {
        // DSH aggregates load errors as strings. Preserve Aura's message identity
        // at the bundle boundary, without interpreting that diagnostic string.
        const failure = bundleFailures.values().next().value;
        if (failure !== undefined) throw new MessageError(failure);
        throw error;
      } finally {
        bundleFailures.clear();
      }
    };
    /**
     * Rows added after boot must reach the module table before import. DSH
     * performs this refresh inside its entry reconciliation; the method is not
     * on the typed surface, so a missing method fails loudly here.
     */
    const updateManifest = (next: PluginPageGraph) => {
      const update = (
        modules as unknown as {
          updateManifest?: (manifest: unknown, managed: string[]) => void;
        }
      ).updateManifest;
      if (typeof update !== "function")
        throw new MessageError(pluginMessage("graphUpdateUnsupported"));
      // Aura owns these fibers and stages their replacement below. DSH must
      // not remove the visible revision's styles while fetching its candidate.
      update.call(modules, loader.parseBootManifest(next), [...fibers.keys()]);
    };

    const unmount = async (id: string) => {
      const fiber = fibers.get(id);
      fibers.delete(id);
      revisions.delete(id);
      if (fiber) await fiber.dispose();
      removeOwnedStyles(id);
    };

    const mountedPlugins = new Map<string, ClientPlugin>();
    const mount = async (id: string, rev: string, plugin: ClientPlugin) => {
      const fiber =
        id === SECRET_MASK_MODULE
          ? root.plugin((scope) => installSecretMask(scope, plugin))
          : pluginOwnerContext(root, id).plugin(plugin);
      fibers.set(id, fiber);
      revisions.set(id, rev);
      try {
        await fiber.await();
        mountedPlugins.set(id, plugin);
      } catch (error) {
        // A failed apply must not leave half-registered pages behind.
        await unmount(id);
        throw error;
      }
    };

    let closed = false;
    const reconcile = async (next: PluginPageGraph) => {
      if (closed) return;
      const wanted = new Map(
        next.entries
          .filter((row) => row.id !== LOADER_ID)
          .map((row) => [row.id, row.rev] as const),
      );
      const nextFailures: PluginFailure[] = [];
      try {
        updateManifest(next);
      } catch (error) {
        failures.splice(0, failures.length, {
          id: "host",
          message: errorMessage(error),
        });
        onChange();
        return;
      }
      for (const id of [...fibers.keys()])
        if (!wanted.has(id)) {
          await unmount(id);
          mountedPlugins.delete(id);
        }
      for (const [id, rev] of wanted) {
        if (closed) return;
        if (revisions.get(id) === rev) continue;
        const previous = mountedPlugins.get(id);
        const previousRev = revisions.get(id);
        try {
          if (previousRev) modules.invalidate(id, rev);
          // Fetch/evaluate the candidate before disposing the visible page.
          const candidate = await loadCandidate(id);
          await unmount(id);
          try {
            await mount(id, rev, candidate);
          } catch (error) {
            if (previous && previousRev) await mount(id, previousRev, previous);
            throw error;
          }
        } catch (error) {
          console.error(`[aura] plugin ${id} failed to mount`, error);
          nextFailures.push({ id, message: errorMessage(error) });
        }
      }
      failures.splice(0, failures.length, ...nextFailures);
      onChange();
    };

    let queue: Promise<void> = Promise.resolve();
    const enqueue = (next: PluginPageGraph) => {
      queue = queue.then(() => reconcile(next)).catch(() => undefined);
      return queue;
    };

    await enqueue(graph);
    // Reconcile is idempotent, so the initial SSE frame is harmless.
    const stopWatch = watchPluginGraph(endpoint, (updated) => {
      void enqueue(updated);
    });
    let closing: Promise<void> | undefined;

    return {
      pages,
      results,
      failures,
      close() {
        if (closing) return closing;
        closed = true;
        stopWatch();
        closing = queue.then(async () => {
          try {
            for (const id of [...fibers.keys()]) await unmount(id);
          } finally {
            try {
              await root.fiber.dispose();
            } finally {
              for (const id of fibers.keys()) removeOwnedStyles(id);
              if (window.__ModuleLoader__ === facade)
                delete window.__ModuleLoader__;
            }
          }
        });
        return closing;
      },
    };
  } catch (error) {
    try {
      await root.fiber.dispose();
    } finally {
      for (const id of fibers.keys()) removeOwnedStyles(id);
      if (window.__ModuleLoader__ === facade) delete window.__ModuleLoader__;
    }
    throw error;
  }
}

export function pluginPageInvoke(
  endpoint: string,
  pluginId: string,
): (
  operation: string,
  input?: JsonValue,
  signal?: AbortSignal,
) => Promise<JsonValue> {
  return (operation, input, signal) =>
    invokePluginPage(endpoint, pluginId, operation, input ?? null, signal);
}
