import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { actionCapabilities } from "../src/actions.ts";
import { PluginCapabilities } from "../src/plugin-capabilities.ts";
import { installHostPluginSdkResolution } from "../src/plugin-sdk-resolution.ts";
import type { CapabilityRoot } from "../src/types.ts";

const capabilityApi = "@aura/plugin-sdk/capability";

// Plugins carry no SDK; the host resolves it, as the runtime does.
installHostPluginSdkResolution(
  join(import.meta.dirname, "../../plugin-sdk/package.json"),
);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-capabilities-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Writes a capability whose provider records every hook into `<dataDir>/log.json`. */
async function writeProvider(root: string, local: string, body = "") {
  const directory = join(root, local);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${local}.capability.js`),
    `
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineCapability } from ${JSON.stringify(capabilityApi)};
export default defineCapability({
  title: ${JSON.stringify(local)},
  open(host) {
    const path = join(host.dataDir, "log.json");
    const log = (entry) => writeFileSync(path, JSON.stringify([...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []), entry]));
    log({ hook: "open", id: ${JSON.stringify(local)}, settings: host.settings ?? null });
    return {
      async invoke(operation, input, call) {
        ${body}
        return { operation, input, runId: call.runId ?? null, rootRunId: call.rootRunId ?? null, stepId: call.stepId ?? null,
          idempotencyKey: call.idempotencyKey ?? null, plugin: host.pluginId, visible: host.runs.list().map((r) => r.id) };
      },
      runSettled(run) { log({ hook: "settled", id: ${JSON.stringify(local)}, run: run.id, status: run.status }); },
      close() { log({ hook: "close", id: ${JSON.stringify(local)} }); },
    };
  },
});
`,
  );
}

const root = (
  dir: string,
  id: string,
  version = "1.0.0",
  settings?: CapabilityRoot["settings"],
): CapabilityRoot => ({
  root: dir,
  pluginRoot: dir,
  namespace: id,
  plugin: { id, name: id, version },
  capabilities: [],
  ...(settings === undefined ? {} : { settings }),
});

const run = (
  id: string,
  plugin: string | undefined,
  extra: Partial<FlowRun> = {},
): FlowRun => ({
  id,
  requestId: id,
  flow: {
    id: plugin ? `${plugin}/flow` : "builtin",
    title: "",
    description: "",
    sourceHash: "a".repeat(64),
    ...(plugin
      ? { plugin: { id: plugin, name: plugin, version: "1.0.0" } }
      : {}),
  },
  input: {},
  mode: "demo",
  status: "completed",
  createdAt: 0,
  steps: [],
  ...extra,
});

const log = async (dataRoot: string, plugin: string) =>
  JSON.parse(
    await readFile(join(dataRoot, plugin, "log.json"), "utf8"),
  ) as Array<Record<string, unknown>>;

test("plugin providers open once with settings, receive the call identity and see only their own Runs", () =>
  fixture(async (dir) => {
    const providers = join(dir, "veya", "capabilities");
    await writeProvider(providers, "world-agent");
    const dataRoot = join(dir, "data");
    const builtins: string[] = [];
    const host = new PluginCapabilities({
      dataRoot,
      builtins: {
        async invoke(capability, operation) {
          builtins.push(`${capability}:${operation}`);
          return { builtin: true };
        },
      },
    });
    const runs = new Map([
      ["root", run("root", "veya")],
      [
        "child",
        run("child", "veya", {
          parent: { runId: "root", stepKey: "plugin/a" },
          rootRunId: "root",
        }),
      ],
      ["other", run("other", "other.plugin")],
    ]);
    host.attachRuns(
      (id) => runs.get(id),
      () => runs.values(),
    );
    await host.replace([root(providers, "veya", "1.0.0", { session: "x" })]);

    const signal = new AbortController().signal;
    const output = (await host.invoke(
      "veya/world-agent",
      "veya.world.list",
      { a: 1 },
      signal,
      { runId: "child", stepId: "plugin/main/list", idempotencyKey: "k1" },
    )) as Record<string, unknown>;
    assert.deepEqual(output, {
      operation: "veya.world.list",
      input: { a: 1 },
      runId: "child",
      rootRunId: "root",
      stepId: "plugin/main/list",
      idempotencyKey: "k1",
      plugin: "veya",
      visible: ["root", "child"],
    });
    assert.deepEqual(
      await host.invoke("aura.tripo.game-asset", "generate", {}, signal),
      { builtin: true },
    );
    assert.deepEqual(builtins, ["aura.tripo.game-asset:generate"]);
    await assert.rejects(
      async () => host.invoke("other.plugin/x", "op", {}, signal),
      /unavailable: other\.plugin\/x/u,
    );
    assert.deepEqual((await log(dataRoot, "veya"))[0], {
      hook: "open",
      id: "world-agent",
      settings: { session: "x" },
    });

    // Same plugin version and settings: no reopen.
    await host.replace([root(providers, "veya", "1.0.0", { session: "x" })]);
    assert.equal(
      (await log(dataRoot, "veya")).filter((e) => e.hook === "open").length,
      1,
    );
    // Changed settings reopen the providers.
    await host.replace([root(providers, "veya", "1.0.0", { session: "y" })]);
    assert.deepEqual(
      (await log(dataRoot, "veya")).map((e) => e.hook),
      ["open", "open", "close"],
    );
    await host.close();
    assert.equal((await log(dataRoot, "veya")).at(-1)?.hook, "close");
  }));

test("workbench pages reach only their own provider's declared page operations", () =>
  fixture(async (dir) => {
    const providers = join(dir, "pages", "capabilities");
    const directory = join(providers, "archive");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "archive.capability.js"),
      `
import { defineCapability } from ${JSON.stringify(capabilityApi)};
export default defineCapability({
  title: "archive",
  open() {
    return {
      pageOperations: ["summary"],
      invoke(operation, input, call) {
        return { operation, input, runId: call.runId ?? null };
      },
    };
  },
});
`,
    );
    const other = join(dir, "other", "capabilities");
    await writeProvider(other, "secret");
    const host = new PluginCapabilities({ dataRoot: join(dir, "data") });
    await host.replace([root(providers, "pages"), root(other, "other")]);
    const signal = new AbortController().signal;

    assert.deepEqual(
      await host.invokeFromPage(
        "pages",
        "pages/archive",
        "summary",
        { q: 1 },
        signal,
      ),
      { operation: "summary", input: { q: 1 }, runId: null },
    );
    await assert.rejects(
      host.invokeFromPage("pages", "pages/archive", "delete", null, signal),
      /page_operation_forbidden/u,
    );
    await assert.rejects(
      host.invokeFromPage("pages", "other/secret", "x", null, signal),
      /page_capability_forbidden/u,
    );
    // Providers without pageOperations stay unreachable from any page.
    await assert.rejects(
      host.invokeFromPage("other", "other/secret", "x", null, signal),
      /page_operation_forbidden/u,
    );
    await assert.rejects(
      host.invokeFromPage("pages", "pages/missing", "x", null, signal),
      /page_capability_unavailable/u,
    );
    await host.close();
  }));

test("runSettled reaches only the owning plugin and a failing hook does not throw", () =>
  fixture(async (dir) => {
    const veya = join(dir, "veya");
    const other = join(dir, "other");
    await writeProvider(veya, "world-agent");
    await writeProvider(other, "probe");
    const dataRoot = join(dir, "data");
    const errors: string[] = [];
    const host = new PluginCapabilities({
      dataRoot,
      log: (level, message) => {
        if (level === "error") errors.push(message);
      },
    });
    await host.replace([root(veya, "veya"), root(other, "other.plugin")]);
    await host.runSettled(run("r1", "veya", { status: "cancelled" }));
    await host.runSettled(run("r2", undefined));
    assert.deepEqual(
      (await log(dataRoot, "veya")).filter((e) => e.hook === "settled"),
      [{ hook: "settled", id: "world-agent", run: "r1", status: "cancelled" }],
    );
    assert.equal(
      (await log(dataRoot, "other.plugin")).some((e) => e.hook === "settled"),
      false,
    );
    assert.deepEqual(errors, []);
    await host.close();
  }));

test("a provider module without defineCapability fails the whole plugin and leaves nothing open", () =>
  fixture(async (dir) => {
    const providers = join(dir, "capabilities");
    await writeProvider(providers, "a-good");
    await mkdir(join(providers, "b-bad"), { recursive: true });
    await writeFile(
      join(providers, "b-bad", "b-bad.capability.js"),
      "export default {};\n",
    );
    const dataRoot = join(dir, "data");
    const host = new PluginCapabilities({ dataRoot });
    await assert.rejects(
      host.replace([root(providers, "broken")]),
      /must default-export defineCapability/u,
    );
    assert.deepEqual(
      (await log(dataRoot, "broken")).map((e) => e.hook),
      ["open", "close"],
    );
    await assert.rejects(
      async () =>
        host.invoke("broken/a-good", "op", {}, new AbortController().signal),
      /unavailable/u,
    );
  }));

test("providers store and read verified artifacts and admit image attachments", () =>
  fixture(async (dir) => {
    const providers = join(dir, "capabilities");
    await mkdir(join(providers, "media"), { recursive: true });
    await writeFile(
      join(providers, "media", "media.capability.js"),
      `
import { defineCapability } from ${JSON.stringify(capabilityApi)};
export default defineCapability({ title: "media", open(host) { return {
  async invoke(operation, input, call) {
    if (operation === "put") return (await host.artifacts.put(Buffer.from(input.base64, "base64"), call.signal)).artifactId;
    if (operation === "read") { const r = await host.artifacts.read(input.id, call.signal); return { bytes: r.bytes.length, format: r.artifact.format }; }
    if (operation === "attach") { const r = await host.artifacts.read(input.id, call.signal); return host.attachments.image(r.bytes, "x.png"); }
    throw new Error(operation);
  } }; } });
`,
    );
    const { GeneratedArtifacts } =
      await import("../src/artifacts/generated.ts");
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#c00" },
    })
      .png()
      .toBuffer();
    const saved: unknown[] = [];
    const host = new PluginCapabilities({
      dataRoot: join(dir, "data"),
      media: {
        artifacts: new GeneratedArtifacts(join(dir, "store")),
        async saveImage(input) {
          saved.push(input.mediaType);
          return { attachmentId: "a1" };
        },
      },
    });
    await host.replace([root(providers, "example.media")]);
    const signal = new AbortController().signal;
    const id = (await host.invoke(
      "example.media/media",
      "put",
      { base64: png.toString("base64") },
      signal,
    )) as string;
    assert.match(id, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      await host.invoke("example.media/media", "read", { id }, signal),
      { bytes: png.length, format: "png" },
    );
    assert.deepEqual(
      await host.invoke("example.media/media", "attach", { id }, signal),
      { attachmentId: "a1" },
    );
    assert.deepEqual(saved, ["image/png"]);
    await assert.rejects(
      async () =>
        host.invoke(
          "example.media/media",
          "read",
          { id: "0".repeat(64) },
          signal,
        ),
      /artifact_missing/u,
    );
    await assert.rejects(
      async () =>
        host.invoke(
          "example.media/media",
          "put",
          { base64: Buffer.from("not media").toString("base64") },
          signal,
        ),
      /artifact_format_unsupported/u,
    );
    await host.close();
  }));

test("the serving provider admits and projects its plugin's service Flows only", () =>
  fixture(async (dir) => {
    const providers = join(dir, "capabilities");
    await mkdir(join(providers, "creator"), { recursive: true });
    await writeFile(
      join(providers, "creator", "creator.capability.js"),
      `
import { defineCapability } from ${JSON.stringify(capabilityApi)};
export default defineCapability({ title: "creator", open() { return {
  serves: ["wish"],
  admit(request) {
    if (request.input.text === "busy") throw new Error("worker_busy");
    return { ...request.input, admittedFor: request.requestId };
  },
  view(run) { return { stage: run.status }; },
  invoke() { return null; },
}; } });
`,
    );
    const host = new PluginCapabilities({ dataRoot: join(dir, "data") });
    await host.replace([root(providers, "veya")]);
    const signal = new AbortController().signal;
    assert.deepEqual(
      await host.admit("veya/wish", "r1", { text: "lamp" }, signal),
      { text: "lamp", admittedFor: "r1" },
    );
    await assert.rejects(
      host.admit("veya/wish", "r2", { text: "busy" }, signal),
      /^Error: worker_busy$/u,
    );
    // A provider without a resume hook refuses resume input.
    await assert.rejects(
      host.resume(
        run("z", "veya", {
          flow: { ...run("z", "veya").flow, id: "veya/wish" },
        }),
        { a: 1 },
        signal,
      ),
      /resume_input_unsupported/u,
    );
    // Flows nobody serves start with their input unchanged and have no projection.
    assert.deepEqual(await host.admit("veya/other", "r3", { a: 1 }, signal), {
      a: 1,
    });
    assert.deepEqual(
      await host.view(
        run("x", "veya", {
          flow: { ...run("x", "veya").flow, id: "veya/wish" },
        }),
      ),
      { stage: "completed" },
    );
    assert.equal(await host.view(run("y", "veya")), undefined);
    await host.close();
  }));

test("Action capability narrowing forwards step and idempotency identity", async () => {
  const seen: unknown[] = [];
  const granted = actionCapabilities(
    { id: "veya/world-list", capabilities: ["veya/world-agent"] },
    {
      async invoke(_c, _o, _i, _s, context) {
        seen.push(context);
        return null;
      },
    },
    { runId: "r", stepId: "plugin/main/list", idempotencyKey: "k" },
  );
  await granted!.invoke(
    "veya/world-agent",
    "op",
    {},
    new AbortController().signal,
  );
  assert.deepEqual(seen, [
    { runId: "r", stepId: "plugin/main/list", idempotencyKey: "k" },
  ]);
});

test("provider helpers reload after calls and Runs finish; failed edits keep the previous revision", () =>
  fixture(async (dir) => {
    const plugin = join(dir, "hot");
    const providers = join(plugin, "capabilities");
    const directory = join(providers, "archive");
    await mkdir(directory, { recursive: true });
    const helper = join(plugin, "shared.js");
    const entry = join(directory, "archive.capability.js");
    const source = `
import { defineCapability } from "@aura/plugin-sdk/capability";
import { version } from "../../shared.js";
export default defineCapability({title:"archive",open(host){return {
  pageOperations:["version"],
  async invoke(operation,input,call){
    if(operation==="wait") await host.invoke("fixture.wait","wait",null,call.signal);
    return {version};
  }
};}});
`;
    await writeFile(helper, 'export const version = "one";\n');
    await writeFile(entry, source);
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<null>();
    const warnings: string[] = [];
    const host = new PluginCapabilities({
      dataRoot: join(dir, "data"),
      builtins: {
        invoke: async () => {
          entered.resolve();
          return pending.promise;
        },
      },
      log: (_level, message) => warnings.push(message),
    });
    try {
      const roots = [{ ...root(providers, "hot"), pluginRoot: plugin }];
      await host.replace(roots);
      const signal = new AbortController().signal;
      const version = () =>
        host.invokeFromPage("hot", "hot/archive", "version", null, signal);
      const waiting = host.invoke("hot/archive", "wait", null, signal);
      await entered.promise;
      await writeFile(helper, 'export const version = "two";\n');
      await host.refresh();
      assert.deepEqual(await version(), { version: "one" });
      pending.resolve(null);
      assert.deepEqual(await waiting, { version: "one" });
      const active = run("active", "hot", { status: "waiting_input" });
      host.attachRuns(
        () => active,
        () => [active],
      );
      await host.refresh();
      assert.deepEqual(await version(), { version: "one" });
      active.status = "completed";
      await host.refresh();
      assert.deepEqual(await version(), { version: "two" });
      await writeFile(entry, "export default { invalid syntax\n");
      await host.refresh();
      await host.refresh();
      assert.deepEqual(await version(), { version: "two" });
      assert.equal(warnings.length, 1, "a broken edit does not spam warnings");
      await assert.rejects(host.replace(roots));
      assert.deepEqual(await version(), { version: "two" });
      await writeFile(entry, source);
      await writeFile(helper, 'export const version = "three";\n');
      await host.refresh();
      assert.deepEqual(await version(), { version: "three" });
    } finally {
      await host.close();
    }
    await assert.rejects(host.replace([]), /plugin_providers_closed/u);
    await host.refresh();
  }));

test("disabled providers retain private services until old Runs and direct Action leases settle", async () =>
  fixture(async (dir) => {
    const providers = join(dir, "providers");
    await writeProvider(providers, "private");
    const host = new PluginCapabilities({ dataRoot: join(dir, "data") });
    const legacy = run("old", undefined, { status: "waiting_input" });
    legacy.flow.id = "legacy-flow";
    host.attachRuns(
      () => legacy,
      () => [legacy],
    );
    const descriptor = {
      ...root(providers, "owner"),
      pluginRoot: dir,
      compatibility: {
        flows: {
          "legacy-flow": { from: ["a".repeat(64)], to: "b".repeat(64) },
        },
      },
    };
    try {
      await host.replace([descriptor]);
      const release = host.serviceRetention("owner")();
      await host.replace([]);
      await assert.rejects(
        host.invokeFromPage(
          "owner",
          "owner/private",
          "read",
          null,
          new AbortController().signal,
        ),
      );
      const logPath = join(dir, "data/owner/log.json");
      const logs = async () =>
        JSON.parse(await readFile(logPath, "utf8")) as Array<{ hook: string }>;
      assert.equal(
        (await logs()).filter((item) => item.hook === "close").length,
        0,
      );
      legacy.status = "completed";
      await host.refresh();
      assert.equal(
        (await logs()).filter((item) => item.hook === "close").length,
        0,
      );
      release();
      release();
      await host.refresh();
      assert.equal(
        (await logs()).filter((item) => item.hook === "close").length,
        1,
      );
    } finally {
      await host.close();
    }
  }));
