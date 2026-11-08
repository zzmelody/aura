export interface ClientBundleRegistration {
  id: string;
  chunk?: string;
  factory(require: (specifier: string) => unknown): unknown;
}

export interface ClientModuleLoaderTarget {
  mode: "queue" | "live";
  pendingQueue: ClientBundleRegistration[];
  load(registration: ClientBundleRegistration): void;
}

declare global {
  interface Window {
    __ModuleLoader__?: ClientModuleLoaderTarget;
  }
}

interface BundleScope {
  host?: ClientModuleLoaderTarget;
  local: Map<string, (registration: ClientBundleRegistration) => void>;
  dispatcher: ClientModuleLoaderTarget;
}

const scopes = new WeakMap<Window, BundleScope>();

function scope(): BundleScope {
  const surface = window;
  const existing = scopes.get(surface);
  if (existing) return existing;
  const next: BundleScope = {
    local: new Map(),
    dispatcher: {
      mode: "queue",
      pendingQueue: [],
      load(registration) {
        const receive = next.local.get(registration.id);
        if (receive) receive(registration);
        else if (next.host) next.host.load(registration);
        else throw new Error("No client module host is available.");
      },
    },
  };
  scopes.set(surface, next);
  return next;
}

function attach(state: BundleScope) {
  if (window.__ModuleLoader__ && window.__ModuleLoader__ !== state.dispatcher)
    throw new Error("A client module host is already active.");
  window.__ModuleLoader__ = state.dispatcher;
}

function detach(surface: Window, state: BundleScope) {
  if (
    !state.host &&
    !state.local.size &&
    surface.__ModuleLoader__ === state.dispatcher
  )
    delete surface.__ModuleLoader__;
}

/** Local core bundles and backend page bundles share DSH's registration hook. */
export function claimClientModuleHost(target: ClientModuleLoaderTarget) {
  const surface = window;
  const state = scope();
  if (state.host) throw new Error("A client module host is already active.");
  attach(state);
  state.host = target;
  return () => {
    if (state.host === target) state.host = undefined;
    detach(surface, state);
  };
}

/** Load an unchanged published browser bundle from the workbench's own assets. */
export async function loadLocalClientBundle(
  href: string,
  id: string,
  signal: AbortSignal,
): Promise<ClientBundleRegistration> {
  signal.throwIfAborted();
  const surface = window;
  const state = scope();
  if (state.local.has(id)) throw new Error("The client bundle is loading.");
  attach(state);
  let registration: ClientBundleRegistration | undefined;
  state.local.set(id, (value) => {
    registration = value;
  });
  const script = document.createElement("script");
  script.src = href;
  script.async = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        script.onload = null;
        script.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(new Error("Client bundle loading stopped."));
      const timer = setTimeout(
        () => finish(new Error("Client bundle loading timed out.")),
        5_000,
      );
      script.onload = () => finish();
      script.onerror = () => finish(new Error("Client bundle loading failed."));
      signal.addEventListener("abort", aborted, { once: true });
      try {
        document.head.append(script);
      } catch {
        finish(new Error("Client bundle loading failed."));
      }
    });
    signal.throwIfAborted();
    if (!registration) throw new Error("The client bundle did not register.");
    return registration;
  } finally {
    script.remove();
    state.local.delete(id);
    detach(surface, state);
  }
}
