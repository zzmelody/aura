import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatModelCatalog } from "@aura/protocol/types";
import { ModelCatalogStore } from "../src/model-catalog-store.ts";
import { StartupCache } from "../src/startup-cache.ts";

const endpoint = "http://localhost:4311";
const catalog: ChatModelCatalog = {
  mode: "codex",
  defaultModel: "fixture",
  models: [{ id: "fixture", name: "Fixture", reasoningEfforts: [] }],
};

test("reopening shows the saved catalog immediately while one live request validates it", async (t) => {
  let saved: string | null = null;
  const cache = new StartupCache(() => ({
    getItem: () => saved,
    setItem: (_key, value) => {
      saved = value;
    },
  }));
  cache.saveModels(endpoint, catalog);
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  const store = new ModelCatalogStore(async () => {
    requests++;
    return response.promise;
  }, cache);
  t.after(() => store.close());
  assert.deepEqual(store.snapshot(endpoint, "codex").catalog, catalog);
  assert.equal(store.snapshot(endpoint, "codex").restored, true);
  store.subscribe(endpoint, "codex", () => {});
  const waiting = store.refresh(endpoint, "codex");
  assert.equal(store.snapshot(endpoint, "codex").loading, true);
  assert.deepEqual(store.snapshot(endpoint, "codex").catalog, catalog);
  response.resolve(
    Response.json({
      ...catalog,
      models: [{ ...catalog.models[0], name: "Live" }],
    }),
  );
  await waiting;
  assert.equal(requests, 1);
  assert.equal(
    store.snapshot(endpoint, "codex").catalog?.models[0]?.name,
    "Live",
  );
  assert.equal(store.snapshot(endpoint, "codex").restored, undefined);
  assert.equal(cache.models(endpoint, "codex")?.models[0]?.name, "Live");
  store.invalidate(endpoint);
  assert.equal(cache.models(endpoint, "codex"), undefined);
});

test("startup and composers share a request and revisiting keeps the ready model catalog", async (t) => {
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  const store = new ModelCatalogStore(async () => {
    requests++;
    return response.promise;
  });
  t.after(() => store.close());
  const first = store.subscribe(endpoint, "codex", () => {});
  const second = store.subscribe(endpoint, "codex", () => {});
  const waiting = store.refresh(endpoint, "codex");
  response.resolve(Response.json(catalog));
  await waiting;
  assert.equal(requests, 1);
  const ready = store.snapshot(endpoint, "codex");
  assert.deepEqual(ready.catalog, catalog);
  assert.equal(ready.loading, false);
  first();
  second();
  store.subscribe(endpoint, "codex", () => {})();
  assert.equal(requests, 1);
  assert.equal(store.snapshot(endpoint, "codex"), ready);
});

test("only the last model subscriber cancels and a remount can start a clean request", async (t) => {
  const signals: AbortSignal[] = [];
  const store = new ModelCatalogStore(async (_url, signal) => {
    signals.push(signal!);
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), {
        once: true,
      });
    });
  });
  t.after(() => store.close());
  const first = store.subscribe(endpoint, "codex", () => {});
  const second = store.subscribe(endpoint, "codex", () => {});
  first();
  assert.equal(signals[0]!.aborted, false);
  second();
  assert.equal(signals[0]!.aborted, true);
  const third = store.subscribe(endpoint, "codex", () => {});
  assert.equal(signals.length, 2);
  assert.equal(signals[1]!.aborted, false);
  third();
});

test("endpoint and provider catalogs never cross and invalidation keeps the last result during revalidation", async (t) => {
  let requests = 0;
  const store = new ModelCatalogStore(async (url) => {
    requests++;
    const mode = new URL(url).searchParams.get("mode");
    return Response.json({ ...catalog, mode });
  });
  t.after(() => store.close());
  store.subscribe(endpoint, "codex", () => {});
  await store.refresh(endpoint, "codex");
  assert.equal(store.snapshot(endpoint, "lumina").catalog, undefined);
  assert.equal(store.snapshot("http://other:4311", "codex").catalog, undefined);
  store.invalidate(endpoint);
  assert.deepEqual(store.snapshot(endpoint, "codex").catalog, catalog);
  assert.equal(store.snapshot(endpoint, "codex").loading, true);
  await store.refresh(endpoint, "codex");
  assert.equal(requests, 2);
  assert.equal(store.snapshot(endpoint, "codex").loading, false);
});

test("a failed model refresh preserves a good catalog and a later retry clears the error", async (t) => {
  let failing = false;
  const store = new ModelCatalogStore(async () =>
    failing
      ? new Response("unavailable", { status: 500 })
      : Response.json(catalog),
  );
  t.after(() => store.close());
  await store.refresh(endpoint, "codex");
  failing = true;
  await store.refresh(endpoint, "codex");
  assert.deepEqual(store.snapshot(endpoint, "codex").catalog, catalog);
  assert.equal(store.snapshot(endpoint, "codex").loading, false);
  assert.ok(store.snapshot(endpoint, "codex").error);
  failing = false;
  await store.refresh(endpoint, "codex");
  assert.equal(store.snapshot(endpoint, "codex").error, "");
});

test("malformed or mismatched model catalogs never become ready data", async (t) => {
  let value: unknown = { ...catalog, mode: "lumina" };
  const store = new ModelCatalogStore(async () => Response.json(value));
  t.after(() => store.close());
  await store.refresh(endpoint, "codex");
  assert.equal(store.snapshot(endpoint, "codex").catalog, undefined);
  assert.ok(store.snapshot(endpoint, "codex").error);
  value = {
    ...catalog,
    models: [{ ...catalog.models[0], reasoningEfforts: [null] }],
  };
  await store.refresh(endpoint, "codex");
  assert.equal(store.snapshot(endpoint, "codex").catalog, undefined);
  assert.ok(store.snapshot(endpoint, "codex").error);
});

test("a late aborted model response cannot replace a newer catalog", async (t) => {
  const old = Promise.withResolvers<Response>();
  let requests = 0;
  const store = new ModelCatalogStore(async () =>
    ++requests === 1 ? old.promise : Response.json(catalog),
  );
  t.after(() => store.close());
  const first = store.subscribe(endpoint, "codex", () => {});
  const pending = store.refresh(endpoint, "codex");
  first();
  store.subscribe(endpoint, "codex", () => {});
  await store.refresh(endpoint, "codex");
  old.resolve(Response.json({ ...catalog, defaultModel: "stale" }));
  await pending;
  assert.equal(
    store.snapshot(endpoint, "codex").catalog?.defaultModel,
    "fixture",
  );
});
