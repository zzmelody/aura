import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  claimClientModuleHost,
  loadLocalClientBundle,
  type ClientBundleRegistration,
} from "../src/client-bundle-loader.ts";

function replaceGlobal(t: TestContext, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

test("local bundle registration survives a concurrent backend host failure and never consumes its page factories", async (t) => {
  const surface = {} as Window;
  const scripts: Array<{
    onload?: (() => void) | null;
    onerror?: (() => void) | null;
    removed?: boolean;
    remove(): void;
  }> = [];
  replaceGlobal(t, "window", surface);
  replaceGlobal(t, "document", {
    createElement: () => ({
      removed: false,
      remove() {
        this.removed = true;
      },
    }),
    head: {
      append(script: (typeof scripts)[number]) {
        scripts.push(script);
      },
    },
  } as unknown as Document);
  const received: ClientBundleRegistration[] = [];
  const stop = new AbortController();
  const loading = loadLocalClientBundle("local.js", "core", stop.signal);
  const release = claimClientModuleHost({
    mode: "queue",
    pendingQueue: [],
    load: (value) => received.push(value),
  });
  const page = { id: "page", factory: () => ({}) };
  surface.__ModuleLoader__!.load(page);
  assert.deepEqual(received, [page]);
  release();
  assert.ok(
    surface.__ModuleLoader__,
    "pending local registrations outlive backend cleanup",
  );
  const core = { id: "core", factory: () => ({}) };
  surface.__ModuleLoader__!.load(core);
  scripts[0]!.onload!();
  assert.equal(await loading, core);
  assert.equal(scripts[0]?.removed, true);
  assert.equal(surface.__ModuleLoader__, undefined);
});

test("failed, unregistered and cancelled local scripts release their registration and can be retried", async (t) => {
  const surface = {} as Window;
  let script: {
    onload?: (() => void) | null;
    onerror?: (() => void) | null;
    remove(): void;
  };
  replaceGlobal(t, "window", surface);
  replaceGlobal(t, "document", {
    createElement: () => ({ remove() {} }),
    head: {
      append(value: typeof script) {
        script = value;
      },
    },
  } as unknown as Document);
  const signal = new AbortController().signal;
  const failed = loadLocalClientBundle("local.js", "core", signal);
  script!.onerror!();
  await assert.rejects(failed, /failed/u);
  assert.equal(surface.__ModuleLoader__, undefined);
  const unregistered = loadLocalClientBundle("local.js", "core", signal);
  script!.onload!();
  await assert.rejects(unregistered, /did not register/u);
  const stop = new AbortController();
  const cancelled = loadLocalClientBundle("local.js", "core", stop.signal);
  stop.abort();
  await assert.rejects(cancelled, /stopped/u);
  assert.equal(surface.__ModuleLoader__, undefined);
});
