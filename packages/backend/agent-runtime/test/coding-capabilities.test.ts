import assert from "node:assert/strict";
import test from "node:test";
import { CodedFlowError, flowErrorBody } from "@aura/protocol/errors";
import type { Context } from "@deepseek-ai/cordis";
import type { Table } from "../src/types.ts";
import {
  CodingCapabilityStore,
  type CapabilityRecord,
} from "../src/conversations/capabilities.ts";

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
};

test("capabilities do not write defaults, expose credentials or accept stale configuration revisions", async () => {
  const { store, table } = fixture();
  assert.deepEqual(await store.snapshot(), {
    ...settings,
    autoCompact: false,
    web: false,
    subagents: false,
    usedRequests: 0,
    unknownRequests: 0,
    hasWebKey: false,
  });
  assert.equal(table.get("settings"), undefined);
  const result = await store.save({
    ...settings,
    key: "synthetic-key-do-not-use",
  });
  assert.equal(result.hasWebKey, true);
  assert.ok(!JSON.stringify(result).includes("synthetic-key"));
  assert.ok(!JSON.stringify(table.get("settings")).includes("synthetic-key"));
  const before = structuredClone(table.get("settings"));
  await assert.rejects(store.save(settings), (error) => {
    assert.ok(error instanceof CodedFlowError);
    assert.equal(error.status, 409);
    assert.match(error.message, /配置已变化/u);
    assert.equal(flowErrorBody(error).code, "settings_revision_conflict");
    return true;
  });
  assert.deepEqual(table.get("settings"), before);
});

test("all request kinds reserve concurrently with the stored zero quota and across restart", async () => {
  const { store, restart, table } = fixture();
  const ids = await Promise.all([
    store.reserve("web", "a"),
    store.reserve("subagent", "b"),
    store.reserve("compaction", "a"),
    store.reserve("goal", "a"),
    store.reserve("mcp", "a"),
    store.reserve("title", "a"),
  ]);
  assert.equal(new Set(ids).size, 6);
  assert.equal(table.get("settings")?.maxRequests, 0);
  assert.equal((await store.snapshot()).usedRequests, 6);
  assert.equal((await store.snapshot()).unknownRequests, 0);
  const recovered = restart();
  assert.equal((await recovered.snapshot()).unknownRequests, 6);
  const id = await recovered.reserve("web", "a");
  await recovered.settle(id, true);
  assert.equal((await recovered.snapshot()).usedRequests, 7);
  assert.equal((await recovered.snapshot()).unknownRequests, 6);
  assert.ok(ids.every((reserved) => table.get("settings")?.entries[reserved]));
});

test("failed paid operations retain unknown results without blocking new requests or changing stored settings", async () => {
  const { store, restart, table } = fixture();
  await store.save(settings);
  const initial = table.get("settings")!;
  await table.put("settings", { ...initial, maxRequests: 1 });
  const failed = await store.reserve("compaction", "a");
  await store.settle(failed, false);
  const recovered = restart();
  await recovered.save({ ...settings, revision: 1, web: false });
  const next = await recovered.reserve("web", "a");
  await recovered.settle(next, true);
  assert.equal((await recovered.snapshot()).usedRequests, 2);
  assert.equal((await recovered.snapshot()).unknownRequests, 1);
  const saved = table.get("settings")!;
  assert.equal(saved.maxRequests, 1);
  assert.equal(saved.revision, 2);
  assert.equal(saved.entries[failed]?.state, "unknown");
  assert.equal(saved.entries[next]?.state, "complete");
});

test("a title reservation cannot be repeated after restart while other conversations remain available", async () => {
  const { store, restart } = fixture();
  await store.settle(await store.reserve("title", "side-chat"), false);
  const recovered = restart();
  await assert.rejects(recovered.reserve("title", "side-chat"), /已请求过/u);
  assert.equal((await recovered.snapshot()).usedRequests, 1);
  const next = await recovered.reserve("title", "another-chat");
  await recovered.settle(next, true);
  await assert.rejects(recovered.reserve("title", "another-chat"), /已请求过/u);
  assert.equal((await recovered.snapshot()).usedRequests, 2);
  assert.equal((await recovered.snapshot()).unknownRequests, 1);
});
