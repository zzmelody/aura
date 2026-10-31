import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { actionCapabilities } from "../src/actions.ts";
import { PluginBackends } from "../src/plugin-backends.ts";
import { installHostPluginSdkResolution } from "../src/plugin-sdk-resolution.ts";
import type { BackendRoot } from "../src/types.ts";

const backendApi = "@aura/plugin-sdk/backend";

// Plugins carry no SDK; the host resolves it, as the runtime does.
installHostPluginSdkResolution(
  join(import.meta.dirname, "../../plugin-sdk/package.json"),
);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-backends-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Writes `<plugin>/backend/index.js` with the given `open(host)` result body. */
async function writeEntry(plugin: string, source: string) {
  await mkdir(join(plugin, "backend"), { recursive: true });
  const entry = join(plugin, "backend", "index.js");
  await writeFile(entry, source);
  return entry;
}

/** A backend that records every hook into `<dataDir>/log.json`. */
function recordingBackend(id: string, members = "") {
  return `
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineBackend } from ${JSON.stringify(backendApi)};
export default defineBackend({
  open(host) {
    const path = join(host.dataDir, "log.json");
    const log = (entry) => writeFileSync(path, JSON.stringify([...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []), entry]));
    log({ hook: "open", id: ${JSON.stringify(id)}, settings: host.settings ?? null });
    return {
      pageOperations: ["echo", "builtin"],
      async invoke(operation, input, call) {
        if (operation === "builtin") return host.invoke("aura.tripo.game-asset", "generate", {}, call.signal);
        return { operation, input, plugin: host.pluginId, visible: host.runs.list().map((r) => r.id) };
      },
      runSettled(run) { log({ hook: "settled", run: run.id, status: run.status }); },
      close() { log({ hook: "close" }); },
      ${members}
    };
  },
});
`;
}

async function plugin(
  dir: string,
  id: string,
  source = recordingBackend(id),
): Promise<BackendRoot> {
  const pluginRoot = join(dir, id);
  return {
    root: await writeEntry(pluginRoot, source),
    pluginRoot,
    namespace: id,
    plugin: { id, name: id, version: "1.0.0" },
    permissions: [],
  };
}

const run = (
  id: string,
  owner: string | undefined,
  extra: Partial<FlowRun> = {},
): FlowRun => ({
  id,
  requestId: id,
  flow: {
    id: owner ? `${owner}/flow` : "builtin",
    title: "",
    description: "",
    sourceHash: "a".repeat(64),
    ...(owner ? { plugin: { id: owner, name: owner, version: "1.0.0" } } : {}),
  },
  input: {},
  mode: "demo",
  status: "completed",
  createdAt: 0,
  steps: [],
  ...extra,
});

const log = async (dataRoot: string, id: string) =>
  JSON.parse(await readFile(join(dataRoot, id, "log.json"), "utf8")) as Array<
    Record<string, unknown>
  >;

const signal = () => new AbortController().signal;

test("a backend opens once with settings, reaches built-ins and sees only its own Runs", () =>
  fixture(async (dir) => {
    const dataRoot = join(dir, "data");
    const builtins: string[] = [];
    const host = new PluginBackends({
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
      ["other", run("other", "other.plugin")],
    ]);
    host.attachRuns(
      (id) => runs.get(id),
      () => runs.values(),
    );
    const veya = await plugin(dir, "veya");
    await host.replace([{ ...veya, settings: { session: "x" } }]);

    assert.deepEqual(
      await host.invokeFromPage("veya", "echo", { a: 1 }, signal()),
      { operation: "echo", input: { a: 1 }, plugin: "veya", visible: ["root"] },
    );
    assert.deepEqual(
      await host.invokeFromPage("veya", "builtin", null, signal()),
      { builtin: true },
    );
    assert.deepEqual(builtins, ["aura.tripo.game-asset:generate"]);
    assert.deepEqual((await log(dataRoot, "veya"))[0], {
      hook: "open",
      id: "veya",
      settings: { session: "x" },
    });

    // Same plugin version and settings: no reopen.
    await host.replace([{ ...veya, settings: { session: "x" } }]);
    assert.equal(
      (await log(dataRoot, "veya")).filter((e) => e.hook === "open").length,
      1,
    );
    // Changed settings reopen the backend.
    await host.replace([{ ...veya, settings: { session: "y" } }]);
    assert.deepEqual(
      (await log(dataRoot, "veya")).map((e) => e.hook),
      ["open", "open", "close"],
    );
    await host.close();
    assert.equal((await log(dataRoot, "veya")).at(-1)?.hook, "close");
  }));

test("pages reach only their own backend's declared page operations", () =>
  fixture(async (dir) => {
    const host = new PluginBackends({ dataRoot: join(dir, "data") });
    const pages = await plugin(dir, "pages");
    const quiet = await plugin(
      dir,
      "quiet",
      `import { defineBackend } from ${JSON.stringify(backendApi)};
export default defineBackend({ open() { return { services: { secret: 1 } }; } });
`,
    );
    await host.replace([pages, quiet]);
    await assert.rejects(
      host.invokeFromPage("pages", "delete", null, signal()),
      /page_operation_forbidden/u,
    );
    // Backends without pageOperations stay unreachable from any page.
    await assert.rejects(
      host.invokeFromPage("quiet", "read", null, signal()),
      /page_operation_forbidden/u,
    );
    await assert.rejects(
      host.invokeFromPage("missing", "echo", null, signal()),
      /page_backend_unavailable/u,
    );
    assert.deepEqual(host.services("quiet"), { secret: 1 });
    await host.close();
  }));

test("runSettled reaches only the owning plugin and a failing hook does not throw", () =>
  fixture(async (dir) => {
    const dataRoot = join(dir, "data");
    const errors: string[] = [];
    const host = new PluginBackends({
      dataRoot,
      log: (level, message) => {
        if (level === "error") errors.push(message);
      },
    });
    await host.replace([
      await plugin(dir, "veya"),
      await plugin(dir, "other.plugin"),
    ]);
    await host.runSettled(run("r1", "veya", { status: "cancelled" }));
    await host.runSettled(run("r2", undefined));
    assert.deepEqual(
      (await log(dataRoot, "veya")).filter((e) => e.hook === "settled"),
      [{ hook: "settled", run: "r1", status: "cancelled" }],
    );
    assert.equal(
      (await log(dataRoot, "other.plugin")).some((e) => e.hook === "settled"),
      false,
    );
    assert.deepEqual(errors, []);
    await host.close();
  }));

test("an entry without defineBackend fails the plugin and leaves nothing open", () =>
  fixture(async (dir) => {
    const host = new PluginBackends({ dataRoot: join(dir, "data") });
    await assert.rejects(
      host.replace([await plugin(dir, "broken", "export default {};\n")]),
      /must default-export defineBackend/u,
    );
    await assert.rejects(
      host.invokeFromPage("broken", "echo", null, signal()),
      /page_backend_unavailable/u,
    );
    await host.close();
  }));

test("page operations without invoke() are rejected and the backend is closed", () =>
  fixture(async (dir) => {
    const dataRoot = join(dir, "data");
    const host = new PluginBackends({ dataRoot });
    const source = recordingBackend("half").replace(
      /async invoke\(operation, input, call\) \{[\s\S]*?\n {6}\},/u,
      "",
    );
    await assert.rejects(
      host.replace([await plugin(dir, "half", source)]),
      /pageOperations without invoke/u,
    );
    assert.deepEqual(
      (await log(dataRoot, "half")).map((e) => e.hook),
      ["open", "close"],
    );
    await host.close();
  }));

test("backends store and read verified artifacts and admit image attachments", () =>
  fixture(async (dir) => {
    const media = await plugin(
      dir,
      "example.media",
      `import { defineBackend } from ${JSON.stringify(backendApi)};
export default defineBackend({ open(host) { return {
  pageOperations: ["put", "read", "attach"],
  async invoke(operation, input, call) {
    if (operation === "put") return (await host.artifacts.put(Buffer.from(input.base64, "base64"), call.signal)).artifactId;
    if (operation === "read") { const r = await host.artifacts.read(input.id, call.signal); return { bytes: r.bytes.length, format: r.artifact.format }; }
    const r = await host.artifacts.read(input.id, call.signal);
    return host.attachments.image(r.bytes, "x.png");
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
    const host = new PluginBackends({
      dataRoot: join(dir, "data"),
      media: {
        artifacts: new GeneratedArtifacts(join(dir, "store")),
        async saveImage(input) {
          saved.push(input.mediaType);
          return { attachmentId: "a1" };
        },
      },
    });
    await host.replace([media]);
    const call = (operation: string, input: object) =>
      host.invokeFromPage(
        "example.media",
        operation,
        input as Parameters<typeof host.invokeFromPage>[2],
        signal(),
      );
    const id = (await call("put", {
      base64: png.toString("base64"),
    })) as string;
    assert.match(id, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await call("read", { id }), {
      bytes: png.length,
      format: "png",
    });
    assert.deepEqual(await call("attach", { id }), { attachmentId: "a1" });
    assert.deepEqual(saved, ["image/png"]);
    await assert.rejects(
      call("read", { id: "0".repeat(64) }),
      /artifact_missing/u,
    );
    await assert.rejects(
      call("put", { base64: Buffer.from("not media").toString("base64") }),
      /artifact_format_unsupported/u,
    );
    await host.close();
  }));

test("the serving backend admits and projects its plugin's service Flows only", () =>
  fixture(async (dir) => {
    const host = new PluginBackends({ dataRoot: join(dir, "data") });
    await host.replace([
      await plugin(
        dir,
        "veya",
        `import { defineBackend } from ${JSON.stringify(backendApi)};
export default defineBackend({ open() { return {
  serves: ["wish"],
  admit(request) {
    if (request.input.text === "busy") throw new Error("worker_busy");
    return { ...request.input, admittedFor: request.requestId };
  },
  view(run) { return { stage: run.status }; },
}; } });
`,
      ),
    ]);
    assert.deepEqual(
      await host.admit("veya/wish", "r1", { text: "lamp" }, signal()),
      { text: "lamp", admittedFor: "r1" },
    );
    await assert.rejects(
      host.admit("veya/wish", "r2", { text: "busy" }, signal()),
      /^Error: worker_busy$/u,
    );
    const wish = (id: string) =>
      run(id, "veya", { flow: { ...run(id, "veya").flow, id: "veya/wish" } });
    // A backend without a resume hook refuses resume input.
    await assert.rejects(
      host.resume(wish("z"), { a: 1 }, signal()),
      /resume_input_unsupported/u,
    );
    // Flows nobody serves start with their input unchanged and have no projection.
    assert.deepEqual(await host.admit("veya/other", "r3", { a: 1 }, signal()), {
      a: 1,
    });
    assert.deepEqual(await host.view(wish("x")), { stage: "completed" });
    assert.equal(await host.view(run("y", "veya")), undefined);
    await host.close();
  }));

test("Action permissions narrow the host port and forward step identity", async () => {
  const seen: unknown[] = [];
  const granted = actionCapabilities(
    { id: "veya/world-list", permissions: ["aura.tripo.game-asset"] },
    {
      async invoke(_c, _o, _i, _s, context) {
        seen.push(context);
        return null;
      },
    },
    { runId: "r", stepId: "plugin/main/list", idempotencyKey: "k" },
  );
  await granted!.invoke("aura.tripo.game-asset", "op", {}, signal());
  assert.deepEqual(seen, [
    { runId: "r", stepId: "plugin/main/list", idempotencyKey: "k" },
  ]);
  assert.throws(
    () => granted!.invoke("aura.flow.invoke", "op", {}, signal()),
    /not declared/u,
  );
});

test("backend helpers reload after calls and Runs finish; failed edits keep the previous revision", () =>
  fixture(async (dir) => {
    const pluginRoot = join(dir, "hot");
    await mkdir(pluginRoot, { recursive: true });
    const helper = join(pluginRoot, "backend", "shared.js");
    const source = `
import { defineBackend } from ${JSON.stringify(backendApi)};
import { version } from "./shared.js";
export default defineBackend({ open(host) { return {
  pageOperations: ["version", "wait"],
  async invoke(operation, input, call) {
    if (operation === "wait") await host.invoke("fixture.wait", "wait", null, call.signal);
    return { version };
  },
}; } });
`;
    const entry = await writeEntry(pluginRoot, source);
    await writeFile(helper, 'export const version = "one";\n');
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<null>();
    const warnings: string[] = [];
    const host = new PluginBackends({
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
      const roots: BackendRoot[] = [
        {
          root: entry,
          pluginRoot,
          namespace: "hot",
          plugin: { id: "hot", name: "hot", version: "1.0.0" },
        },
      ];
      await host.replace(roots);
      const version = () =>
        host.invokeFromPage("hot", "version", null, signal());
      const waiting = host.invokeFromPage("hot", "wait", null, signal());
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
    await assert.rejects(host.replace([]), /plugin_backends_closed/u);
    await host.refresh();
  }));

test("disabled backends retain private services until old Runs and direct Action leases settle", async () =>
  fixture(async (dir) => {
    const host = new PluginBackends({ dataRoot: join(dir, "data") });
    const legacy = run("old", undefined, { status: "waiting_input" });
    legacy.flow.id = "legacy-flow";
    host.attachRuns(
      () => legacy,
      () => [legacy],
    );
    const descriptor: BackendRoot = {
      ...(await plugin(dir, "owner")),
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
        host.invokeFromPage("owner", "echo", null, signal()),
        /page_backend_unavailable/u,
      );
      const closes = async () =>
        (await log(join(dir, "data"), "owner")).filter(
          (item) => item.hook === "close",
        ).length;
      assert.equal(await closes(), 0);
      legacy.status = "completed";
      await host.refresh();
      assert.equal(await closes(), 0);
      release();
      release();
      await host.refresh();
      assert.equal(await closes(), 1);
    } finally {
      await host.close();
    }
  }));
