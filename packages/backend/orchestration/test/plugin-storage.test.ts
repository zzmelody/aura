import assert from "node:assert/strict";
import test from "node:test";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { PluginDomainStorage } from "../src/plugin-storage.ts";

test("plugin domains keep legacy storage names and lease concurrent provider revisions", async () => {
  const opened: string[] = [];
  const closed: string[] = [];
  const table = { marker: "existing records" };
  const storage = new PluginDomainStorage(
    {
      open: async (spec: { name: string }) => {
        opened.push(spec.name);
        return {
          table: () => table,
          close: async () => {
            closed.push(spec.name);
          },
        };
      },
    } as unknown as ConstructorParameters<typeof PluginDomainStorage>[0],
    "/dsh-home",
  );
  const port = storage.forPlugin("one.tools", {
    storageDomains: ["legacy_documents"],
    directories: ["legacy-cache"],
  });
  const spec = defineDomain({
    name: "legacy_documents",
    version: 1,
    layout: "per-record",
    tables: { documents: domainTable(z.object({ id: z.string() })) },
  });
  const [one, two] = await Promise.all([port.open(spec), port.open(spec)]);
  assert.deepEqual(opened, ["legacy_documents"]);
  assert.equal(one.table("documents"), table);
  assert.equal(two.table("documents"), table);
  assert.equal(
    port.directory("legacy-cache").replaceAll("\\", "/"),
    "/dsh-home/legacy-cache",
  );
  await assert.rejects(
    port.open({ ...spec, name: "other_documents" }),
    /forbidden/u,
  );
  await assert.rejects(
    port.open({ ...spec, version: 2 }),
    /revision_conflict/u,
  );
  await assert.rejects(
    storage
      .forPlugin("two.tools", { storageDomains: ["legacy_documents"] })
      .open(spec),
    /conflict/u,
  );
  assert.throws(() => port.directory("../credentials"), /forbidden/u);
  assert.notEqual(
    storage.forPlugin("a-b").namespace,
    storage.forPlugin("a.b").namespace,
  );
  await one.close();
  await one.close();
  assert.equal(closed.length, 0);
  await two.close();
  assert.deepEqual(closed, ["legacy_documents"]);
});
