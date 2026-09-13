// Loaded only by the development Vite plugin, never included in published assets.
type Version = { session: string; revision: number };

const initial = document.querySelector<HTMLMetaElement>(
  'meta[name="aura-dev-version"]',
);
let previous: Version | undefined = initial
  ? JSON.parse(initial.content)
  : undefined;
let connected = false;
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;

import.meta.hot?.on("vite:ws:connect", () => {
  connected = true;
});
import.meta.hot?.on("vite:ws:disconnect", () => {
  connected = false;
});
// The initial socket connection can precede this module's event subscriptions.
import.meta.hot?.on("vite:beforeUpdate", () => {
  connected = true;
});

async function poll() {
  if (stopped || document.hidden) return;
  request = new AbortController();
  const timeout = setTimeout(() => request?.abort(), 2500);
  try {
    const response = await fetch("/@aura/dev-version", {
      cache: "no-store",
      signal: request.signal,
    });
    if (!response.ok) return;
    const next = (await response.json()) as Version;
    if (typeof next.session !== "string" || typeof next.revision !== "number")
      return;
    // A new server cannot apply updates missed while the previous server was down.
    if (
      previous &&
      (previous.session !== next.session ||
        (!connected && previous.revision !== next.revision))
    ) {
      stopped = true;
      location.reload();
      return;
    }
    previous = next;
  } catch {
    // Keep retrying through a development server restart or temporary disconnection.
  } finally {
    clearTimeout(timeout);
    request = undefined;
    if (!stopped) timer = setTimeout(poll, 1000);
  }
}

function resume() {
  if (document.hidden || stopped || request) return;
  clearTimeout(timer);
  void poll();
}

function stop() {
  stopped = true;
  clearTimeout(timer);
  request?.abort();
  document.removeEventListener("visibilitychange", resume);
  window.removeEventListener("pagehide", stop);
}

document.addEventListener("visibilitychange", resume);
window.addEventListener("pagehide", stop);
import.meta.hot?.dispose(stop);
void poll();

export {};
