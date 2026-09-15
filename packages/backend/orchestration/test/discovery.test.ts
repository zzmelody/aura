import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import type { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { z } from "zod";
import { ActionDiscovery, FlowDiscovery } from "../src/discovery.ts";
import { ActionRegistry } from "../src/action-registry.ts";
import type { ActionRegistrationConfig } from "../src/action-api.ts";
import type {
  FlowDefinition,
  FlowRegistrationConfig,
} from "../src/flow-api.ts";
import { FlowRegistry, hashFlowDirectory } from "../src/registry.ts";

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aura-flow-discovery-test-"));
  try {
    await run(root);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("aura-flow-discovery-test-"));
    await rm(root, { recursive: true, force: true });
  }
}

const definition: FlowDefinition = {
  title: "Loaded",
  input: z.object({ task: z.string() }),
  output: z.object({ report: z.string() }),
  run: async () => ({ report: "ok" }),
};

function loaderFor(registry: FlowRegistry) {
  let nextId = 0;
  const created: FlowRegistrationConfig[] = [];
  const removed: string[] = [];
  const loader = {
    async create(options: { config: FlowRegistrationConfig }) {
      created.push(options.config);
      await registry.register(options.config, definition);
      return `loader-${++nextId}`;
    },
    async remove(id: string) {
      removed.push(id);
    },
  } as unknown as Loader;
  return { loader, created, removed };
}

async function addEntry(root: string, id: string) {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.flow.js`), "export default {};\n");
  return directory;
}

test("discovery accepts one exact entry and tracks add/remove without restart", async () =>
  withRoot(async (root) => {
    const registry = new FlowRegistry();
    const mock = loaderFor(registry);
    const discovery = new FlowDiscovery(mock.loader, registry, root);

    await addEntry(root, "first");
    await discovery.refresh();
    assert.deepEqual(
      registry.catalog().map(({ id }) => id),
      ["first"],
    );

    await addEntry(root, "second-flow");
    await discovery.refresh();
    assert.deepEqual(
      registry.catalog().map(({ id }) => id),
      ["first", "second-flow"],
    );
    assert.equal(mock.created.length, 2);

    const removedPath = join(root, "first");
    assert.equal(dirname(resolve(removedPath)), resolve(root));
    await rm(removedPath, { recursive: true });
    await discovery.refresh();
    assert.deepEqual(
      registry.catalog().map(({ id }) => id),
      ["second-flow"],
    );
    assert.deepEqual(mock.removed, ["loader-1"]);
  }));

test("external roots register canonical plugin ids and metadata", async () =>
  withRoot(async (root) => {
    await addEntry(root, "brief");
    const registry = new FlowRegistry();
    const mock = loaderFor(registry);
    const plugin = {
      id: "example.creative",
      name: "Example Creative",
      version: "1.2.3",
    };
    const discovery = new FlowDiscovery(mock.loader, registry, {
      root,
      namespace: plugin.id,
      plugin,
    });
    await discovery.refresh();
    assert.equal(mock.created[0]?.flowId, "example.creative/brief");
    assert.deepEqual(mock.created[0]?.plugin, plugin);
    assert.deepEqual(registry.catalog()[0]?.plugin, plugin);
    assert.equal(
      registry.source("example.creative/brief").id,
      "example.creative/brief",
    );
    await discovery.close();
  }));

test("discovery reports illegal ids, mismatched names and nested extra entries", async () =>
  withRoot(async (root) => {
    await addEntry(root, "valid");
    await mkdir(join(root, "wrong-name"), { recursive: true });
    await writeFile(
      join(root, "wrong-name", "other.flow.js"),
      "export default {};\n",
    );
    await addEntry(root, "bad id");
    const duplicate = await addEntry(root, "duplicate");
    await mkdir(join(duplicate, "lib"));
    await writeFile(
      join(duplicate, "lib", "extra.flow.js"),
      "export default {};\n",
    );

    const registry = new FlowRegistry();
    const discovery = new FlowDiscovery(
      loaderFor(registry).loader,
      registry,
      root,
    );
    await discovery.refresh();
    const catalog = registry.catalog();

    assert.equal(catalog.find(({ id }) => id === "valid")?.available, true);
    assert.match(
      catalog.find(({ id }) => id === "wrong-name")?.error ?? "",
      /必须且只能/,
    );
    assert.match(
      catalog.find(({ id }) => id === "bad id")?.error ?? "",
      /无效/,
    );
    assert.match(
      catalog.find(({ id }) => id === "duplicate")?.error ?? "",
      /必须且只能/,
    );
  }));

test("directory hash includes nested helper names and contents", async () =>
  withRoot(async (root) => {
    const directory = await addEntry(root, "hash-check");
    await mkdir(join(directory, "lib"));
    const helper = join(directory, "lib", "prompt.js");
    await writeFile(helper, 'export const prompt = "v1";\n');
    const first = await hashFlowDirectory(directory);
    await writeFile(helper, 'export const prompt = "v2";\n');
    const second = await hashFlowDirectory(directory);
    assert.notEqual(first, second);
    assert.equal(first.length, 64);
    assert.equal(second.length, 64);
  }));

test("source preview stays with the registered revision until a successful reload", async () =>
  withRoot(async (root) => {
    const directory = await addEntry(root, "preview");
    const entry = join(directory, "preview.flow.js");
    const config = { flowId: "preview", directory, entry };
    const registry = new FlowRegistry();
    await registry.register(config, definition);
    const first = registry.source("preview");
    assert.equal(first.code, "export default {};\n");
    assert.equal(first.sourceHash, registry.catalog()[0].sourceHash);
    await writeFile(entry, "export default { version: 2 };\n");
    registry.reloadProblem("preview", "reload pending");
    assert.deepEqual(registry.source("preview"), first);
    await registry.register(config, definition);
    assert.match(registry.source("preview").code, /version: 2/);
    assert.notEqual(registry.source("preview").sourceHash, first.sourceHash);
    assert.throws(() => registry.source("../preview"), /不存在/);
    registry.remove("preview");
    assert.throws(() => registry.source("preview"), /不存在/);
  }));

test("Action discovery enforces directory ids and exactly one matching entry", async () =>
  withRoot(async (root) => {
    const registry = new ActionRegistry();
    const removed: string[] = [];
    const loader = {
      async create({ config }: { config: ActionRegistrationConfig }) {
        await registry.register(config, {
          title: "Test",
          description: "Test action",
          tool: (name) => ({
            name,
            description: "Test",
            parameters: { type: "object" },
            output: { schema: { type: "string" }, render: () => [] },
            timeoutMs: 1000,
            execute: async () => "ok",
          }),
        });
        return config.actionId;
      },
      async remove(id: string) {
        removed.push(id);
      },
    } as unknown as Loader;
    const discovery = new ActionDiscovery(loader, registry, root);
    for (const id of ["valid", "bad id", "mismatch", "duplicate", "run_code"]) {
      await mkdir(join(root, id));
      await writeFile(
        join(root, id, `${id === "mismatch" ? "other" : id}.action.js`),
        "export default {};",
      );
    }
    await mkdir(join(root, "duplicate", "lib"));
    await writeFile(
      join(root, "duplicate", "lib", "extra.action.js"),
      "export default {};",
    );
    await discovery.refresh();
    assert.deepEqual(
      registry
        .catalog()
        .filter((a) => a.available)
        .map((a) => a.id),
      ["valid"],
    );
    assert.equal(registry.catalog().filter((a) => !a.available).length, 4);
    const entry = join(root, "valid", "valid.action.js");
    assert.equal(dirname(resolve(entry)), resolve(root, "valid"));
    await rm(entry);
    await discovery.refresh();
    assert.deepEqual(removed, ["valid"]);
    assert.equal(
      registry.catalog().find((a) => a.id === "valid")?.available,
      false,
    );
    await discovery.close();
  }));
