import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Table } from "../src/types.ts";
import {
  CodingCapabilityStore,
  type CapabilityRecord,
} from "../src/coding/capabilities.ts";

function fixture() {
  let record: CapabilityRecord | undefined;
  let key: string | undefined;
  const table: Table<CapabilityRecord> = {
    get: () => record && structuredClone(record),
    entries: function* () {
      if (record) yield ["settings", structuredClone(record)];
    },
    put: async (_id, value) => {
      record = structuredClone(value);
    },
    delete: async () => false,
    update: async (_id, change) => {
      record = change(record!);
      return structuredClone(record);
    },
  };
  const credentials = {
    describe: async () => ({ configured: !!key }),
    resolve: async () => (key ? { value: key, source: "test" } : undefined),
    set: async (_ref: unknown, value: string) => {
      key = value;
    },
    unset: async () => {
      key = undefined;
    },
  } as unknown as Context["credentials"];
  return {
    store: new CodingCapabilityStore(table, credentials),
    restart: () => new CodingCapabilityStore(table, credentials),
    table,
  };
}
const settings = {
  revision: 0,
  autoCompact: true,
  web: true,
  subagents: true,
  maxRequests: 2,
};

test("capabilities do not write defaults, expose credentials or accept stale configuration revisions", async () => {
  const { store, table } = fixture();
  assert.equal((await store.snapshot()).maxRequests, 0);
  assert.equal(table.get("settings"), undefined);
  await assert.rejects(store.reserve("web", "chat"), /额度不足/u);
  const result = await store.save({
    ...settings,
    key: "synthetic-key-do-not-use",
  });
  assert.equal(result.hasWebKey, true);
  assert.ok(!JSON.stringify(result).includes("synthetic-key"));
  assert.ok(!JSON.stringify(table.get("settings")).includes("synthetic-key"));
  await assert.rejects(store.save(settings), /配置已变化/u);
});

test("concurrent reservations respect the allowance and uncertain results block further requests across restart", async () => {
  const { store, restart } = fixture();
  await store.save(settings);
  const results = await Promise.allSettled([
    store.reserve("web", "a"),
    store.reserve("subagent", "b"),
    store.reserve("compaction", "a"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    2,
  );
  assert.equal((await store.snapshot()).unknownRequests, 0);
  const recovered = restart();
  assert.equal((await recovered.snapshot()).unknownRequests, 2);
  await assert.rejects(recovered.reserve("web", "a"), /结果未知/u);
  await recovered.save({
    ...settings,
    revision: 1,
    maxRequests: 3,
    acknowledgeUnknown: true,
  });
  const id = await recovered.reserve("web", "a");
  await recovered.settle(id, true);
  assert.equal((await recovered.snapshot()).usedRequests, 3);
  assert.equal((await recovered.snapshot()).unknownRequests, 0);
});

test("failed paid operations retain reservations and require an explicit acknowledgement", async () => {
  const { store } = fixture();
  await store.save(settings);
  await store.settle(await store.reserve("compaction", "a"), false);
  await assert.rejects(store.reserve("compaction", "a"), /结果未知/u);
  assert.equal((await store.snapshot()).usedRequests, 1);
  await store.save({ ...settings, revision: 1, acknowledgeUnknown: true });
  assert.ok(await store.reserve("web", "a"));
});
