import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { FlowError } from "@aura/orchestration";
import { createApiApp } from "../src/api-server.ts";
import { parseCombo, PluginPageRegistry } from "../src/plugin-pages.ts";
import type { CodexAuthPort } from "../src/types.ts";

const codexAuth: CodexAuthPort = {
  modelId: "gpt-test",
  async status() {
    return { state: "signed_out", model: this.modelId };
  },
  async startLogin(method) {
    return { state: "pending", method, model: this.modelId };
  },
  submitLoginInput() {
    return { state: "signed_out", model: this.modelId };
  },
  async cancelLogin() {
    return { state: "signed_out", model: this.modelId };
  },
};

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-pages-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const registration = (id: string, body = "return {};") =>
  `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory(require){${body}}});\n//# sourceMappingURL=client.js.map\n`;

test("enabled page bundles refresh automatically, recover from broken writes and stop on close", () =>
  fixture(async (root) => {
    const loader = join(root, "loader.js");
    const page = join(root, "client.js");
    await writeFile(loader, registration("@deepseek-ai/dsh-client-modules"));
    await writeFile(page, registration("wechat-history"));
    let warnings = 0;
    const registry = new PluginPageRegistry({
      loaderPath: loader,
      onReloadError: () => warnings++,
    });
    const roots = [
      {
        pluginRoot: root,
        bundlePath: page,
        plugin: { id: "wechat-history", name: "微信", version: "0.1.0" },
      },
    ];
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (!condition() && Date.now() < deadline) await delay(10);
      assert.ok(condition(), "automatic refresh did not complete");
    };
    try {
      await registry.replace(roots);
      registry.startWatching(10);
      const original = registry.snapshot().rev;
      await writeFile(
        page,
        registration("wechat-history", "return {version:2};"),
      );
      await until(() => registry.snapshot().rev !== original);
      const updated = registry.snapshot().rev;
      await writeFile(page, "unfinished build");
      await until(() => warnings > 0);
      assert.equal(registry.snapshot().rev, updated);
      await writeFile(
        page,
        registration("wechat-history", "return {version:3};"),
      );
      await until(() => registry.snapshot().rev !== updated);
      await registry.replace([]);
      await writeFile(
        page,
        registration("wechat-history", "return {version:4};"),
      );
      await delay(35);
      assert.equal(registry.snapshot().bundles.length, 0);
    } finally {
      await registry.close();
    }
    const closed = registry.snapshot().rev;
    await writeFile(
      page,
      registration("wechat-history", "return {version:5};"),
    );
    await delay(35);
    assert.equal(registry.snapshot().rev, closed);
  }));

test("combo URLs parse plain and scoped package IDs and reject other shapes", () => {
  assert.deepEqual(
    parseCombo("http://h/plugins/??wechat-history/client.js&rev=abc123"),
    { ids: ["wechat-history"], rev: "abc123" },
  );
  assert.deepEqual(
    parseCombo(
      "/plugins/??@deepseek-ai/dsh-client-modules/client.js,a/client.js&rev=f0",
    ),
    { ids: ["@deepseek-ai/dsh-client-modules", "a"], rev: "f0" },
  );
  assert.equal(parseCombo("/plugins/??../x/client.js&rev=1"), undefined);
  assert.equal(parseCombo("/plugins/??a/other.js&rev=1"), undefined);
  assert.equal(parseCombo("/plugins/??a/client.js"), undefined);
  assert.equal(parseCombo("/plugins/pages"), undefined);
});

test("registry composes DSH's boot graph and serves only live revisions", () =>
  fixture(async (root) => {
    const loader = join(root, "loader.js");
    const page = join(root, "client.js");
    await writeFile(loader, registration("@deepseek-ai/dsh-client-modules"));
    await writeFile(page, registration("wechat-history"));
    const registry = new PluginPageRegistry({ loaderPath: loader });
    let changes = 0;
    registry.onChange(() => changes++);
    const identity = { id: "wechat-history", name: "微信", version: "0.1.0" };
    await registry.replace([
      { pluginRoot: root, bundlePath: page, plugin: identity },
    ]);
    const snapshot = registry.snapshot();
    assert.equal(changes, 1);
    assert.equal(snapshot.bundles.length, 1);
    assert.deepEqual(
      snapshot.graph.entries.map((entry) => entry.id),
      [
        "@deepseek-ai/dsh-client-modules",
        "@deepseek-ai/dsh-client-ui-secret-mask",
        "wechat-history",
      ],
    );
    assert.deepEqual(
      snapshot.graph.batches.map((batch) => batch.phase),
      ["bootstrap", "application", "application"],
    );
    assert.ok(snapshot.graph.entries[1]?.external?.includes("react"));

    const served = registry.resource(`/${snapshot.bundles[0]!.url}`);
    assert.equal(served.status, 200);
    const text = served.body!.toString("utf8");
    assert.match(text, /__ModuleLoader__/u);
    assert.doesNotMatch(text, /sourceMappingURL/u);
    assert.equal(
      registry.resource("/plugins/??wechat-history/client.js&rev=stale").status,
      404,
    );
    assert.equal(
      registry.resource(`/plugins/??other/client.js&rev=${snapshot.rev}`)
        .status,
      404,
    );

    // An unchanged re-apply keeps the graph; disabling removes the row.
    await registry.replace([
      { pluginRoot: root, bundlePath: page, plugin: identity },
    ]);
    assert.equal(changes, 1);
    await registry.replace([]);
    assert.equal(changes, 2);
    assert.equal(registry.snapshot().bundles.length, 0);
    assert.equal(registry.resource(`/${snapshot.bundles[0]!.url}`).status, 404);

    // A bundle that is not a DSH registration fails the apply atomically.
    await writeFile(page, "console.log('esm');\n");
    await assert.rejects(
      registry.replace([
        { pluginRoot: root, bundlePath: page, plugin: identity },
      ]),
      /lazy-CJS/u,
    );
    assert.equal(registry.snapshot().bundles.length, 0);
  }));

test("Hono API serves combo scripts, the graph and per-plugin page invoke", () =>
  fixture(async (root) => {
    const loader = join(root, "loader.js");
    const page = join(root, "client.js");
    await writeFile(loader, registration("@deepseek-ai/dsh-client-modules"));
    await writeFile(page, registration("wechat-history"));
    const pluginPages = new PluginPageRegistry({ loaderPath: loader });
    await pluginPages.replace([
      {
        pluginRoot: root,
        bundlePath: page,
        plugin: { id: "wechat-history", name: "微信", version: "0.1.0" },
      },
    ]);
    const calls: unknown[] = [];
    const flows = {
      async request(method: string, params: object) {
        calls.push({ method, params });
        if ((params as { operation?: string }).operation === "drop")
          throw new FlowError("page_operation_forbidden", 403);
        return { ok: true };
      },
    };
    const app = createApiApp({
      codexAuth,
      pluginPages,
      flows: flows as never,
    });

    const state = await app.request("/plugins/pages");
    assert.equal(state.status, 200);
    const body = (await state.json()) as {
      bundles: Array<{ url: string }>;
      loader: { url: string };
    };
    const script = await app.request(`/${body.bundles[0]!.url}`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("Content-Type") ?? "", /javascript/u);
    assert.equal((await app.request(`/${body.loader.url}`)).status, 200);
    assert.equal((await app.request("/plugins/graph")).status, 200);

    const invoke = await app.request("/plugins/pages/wechat-history/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "summary",
        input: { a: 1 },
      }),
    });
    assert.equal(invoke.status, 200);
    assert.deepEqual(calls[0], {
      method: "plugins/page-invoke",
      params: {
        pluginId: "wechat-history",
        operation: "summary",
        input: { a: 1 },
      },
    });
    const status = await app.request("/plugins/pages/wechat-history/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "sync-status",
      }),
    });
    assert.equal(status.status, 200);
    assert.deepEqual(calls[1], {
      method: "plugins/page-invoke",
      params: {
        pluginId: "wechat-history",
        operation: "sync-status",
        input: null,
      },
    });
    const malformed = await app.request(
      "/plugins/pages/wechat-history/invoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "invalidOperation",
        }),
      },
    );
    assert.equal(malformed.status, 400);
    assert.equal(calls.length, 2, "invalid names never reach the DSH worker");
    const refused = await app.request("/plugins/pages/wechat-history/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "drop",
      }),
    });
    assert.equal(refused.status, 403);
    const foreign = await app.request("/plugins/pages", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
    const large = await app.request("/plugins/pages/wechat-history/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "summary",
        input: { text: "x".repeat(300_000) },
      }),
    });
    assert.equal(
      large.status,
      200,
      "product drafts can exceed the old small-message limit",
    );
    const oversized = await app.request(
      "/plugins/pages/wechat-history/invoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "summary",
          input: { text: "x".repeat(4 * 1024 * 1024) },
        }),
      },
    );
    assert.equal(oversized.status, 413);
  }));
