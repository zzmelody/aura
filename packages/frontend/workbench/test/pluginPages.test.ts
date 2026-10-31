import assert from "node:assert/strict";
import test from "node:test";
import { PluginHostLifecycle } from "../src/pluginHostLifecycle.ts";
import {
  invokePluginPage,
  isPluginTab,
  pluginTab,
  pluginTabId,
} from "../src/pluginPages.ts";

test("plugin tabs round-trip canonical page IDs", () => {
  const tab = pluginTab("wechat-history/history");
  assert.equal(tab, "plugin:wechat-history/history");
  assert.ok(isPluginTab(tab));
  assert.equal(pluginTabId(tab), "wechat-history/history");
  assert.equal(isPluginTab("studio:content"), false);
});

test("concurrent browser hosts dispose their predecessor and recover after a failed boot", async () => {
  const lifecycle = new PluginHostLifecycle<{ close(): Promise<void> }>();
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const first = lifecycle.start(async () => {
    await gate.promise;
    events.push("first");
    return {
      async close() {
        events.push("closed");
      },
    };
  });
  const second = lifecycle.start(async () => {
    events.push("second");
    return {
      async close() {
        events.push("closed-second");
      },
    };
  });
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "closed", "second"]);
  await assert.rejects(
    lifecycle.start(async () => {
      throw new Error("boot failed");
    }),
    /boot failed/,
  );
  await lifecycle.start(async () => ({ async close() {} }));
  assert.equal(events.at(-1), "closed-second");
});

test("page invoke is scoped to the calling plugin's backend", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ message: "page_operation_forbidden" }),
      {
        status: 403,
      },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      invokePluginPage("http://127.0.0.1:4311", "wechat-history", "drop"),
      /page_operation_forbidden/u,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:4311/plugins/pages/wechat-history/invoke",
      body: {
        operation: "drop",
        input: null,
      },
    },
  ]);
});
