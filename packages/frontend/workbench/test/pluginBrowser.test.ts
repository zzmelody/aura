import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { startPluginHost } from "../src/pluginHost.ts";

test("real DSH browser bundle mounts a React page, cleans styles and recovers from failed startup without network", async (t) => {
  const workspace = new URL("../../../../", import.meta.url);
  const require = createRequire(
    new URL("packages/backend/runtime/package.json", workspace),
  );
  const loaderId = "@deepseek-ai/dsh-client-modules";
  const loader = await readFile(require.resolve(`${loaderId}/client`), "utf8");
  const client = await readFile(
    new URL("plugins/wechat-history/client/dist/client.js", workspace),
    "utf8",
  );
  const endpoint = "http://fixture.invalid";
  const sources = new Map([
    [`${endpoint}/loader.js?rev=loader1`, loader],
    [`${endpoint}/wechat.js?rev=page1`, client],
  ]);
  const entries = [
    {
      id: loaderId,
      url: "loader.js?rev=loader1",
      rev: "loader1",
      immediately: true,
    },
    {
      id: "wechat-history",
      url: "wechat.js?rev=page1",
      rev: "page1",
      external: ["react", "react/jsx-runtime", "@aura/plugin-ui"],
    },
  ];
  const graph = {
    rev: "graph1",
    entries,
    batches: entries.map((row) => ({
      phase: row.id === loaderId ? "bootstrap" : "application",
      url: row.url,
      rev: row.rev,
      entries: [row.id],
    })),
  };
  const styles = new Set<FakeElement>();
  class FakeElement {
    src = "";
    dataset: Record<string, string> = {};
    textContent = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly tag: string;
    constructor(tag: string) {
      this.tag = tag;
    }
    remove() {
      styles.delete(this);
    }
    getAttribute(name: string) {
      return name === "data-plugin" ? (this.dataset.plugin ?? null) : null;
    }
  }
  let watchers = 0;
  let graphListener: ((event: MessageEvent<string>) => void) | undefined;
  class FakeEventSource {
    onmessage = null;
    constructor() {
      watchers++;
    }
    addEventListener(
      name: string,
      listener: (event: MessageEvent<string>) => void,
    ) {
      if (name === "graph") graphListener = listener;
    }
    close() {
      watchers--;
    }
  }
  const fakeWindow = {};
  const fakeDocument = {
    createElement: (tag: string) => new FakeElement(tag),
    head: {
      append(element: FakeElement) {
        if (element.tag === "style") {
          styles.add(element);
          return;
        }
        queueMicrotask(() => {
          const source = sources.get(element.src);
          if (!source) {
            element.onerror?.();
            return;
          }
          try {
            runInThisContext(source, { filename: element.src });
            element.onload?.();
          } catch {
            element.onerror?.();
          }
        });
      },
    },
    querySelectorAll: () => [...styles],
  };
  const replacements = {
    window: fakeWindow,
    document: fakeDocument,
    EventSource: FakeEventSource,
    fetch: async () =>
      new Response(JSON.stringify(graph), {
        headers: { "Content-Type": "application/json" },
      }),
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  let revisions = 0;
  const first = await startPluginHost(endpoint, () => revisions++);
  t.after(() => first.close());
  assert.deepEqual(first.failures, []);
  const page = first.pages.get("wechat-history/history");
  assert.ok(page, "the compiled client registered its workbench page");
  assert.equal(styles.size, 1);
  assert.equal(watchers, 1);
  const html = renderToStaticMarkup(
    page.definition.render({
      endpoint,
      pluginId: "wechat-history",
      invoke: async () => null,
      onBack: () => undefined,
      onDirtyChange: () => undefined,
    }),
  );
  assert.match(html, /微信聊天/u);
  assert.match(html, /搜索聊天记录/u);
  assert.match(html, /打开时自动同步/u);
  const update = async (url: string, rev: string) => {
    const revisionUrl = `${url}?rev=${rev}`;
    const previous = revisions;
    const next = {
      ...graph,
      rev,
      entries: [entries[0], { ...entries[1], url: revisionUrl, rev }],
      batches: [
        graph.batches[0],
        {
          phase: "application",
          url: revisionUrl,
          rev,
          entries: ["wechat-history"],
        },
      ],
    };
    assert.ok(graphListener);
    graphListener({
      data: JSON.stringify({ graph: next }),
    } as MessageEvent<string>);
    const deadline = Date.now() + 2_000;
    while (revisions === previous && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.ok(revisions > previous, "the SSE graph was not reconciled");
  };
  sources.set(
    `${endpoint}/wechat2.js?rev=page2`,
    client.replaceAll("微信聊天", "微信聊天更新版"),
  );
  await update("wechat2.js", "page2");
  const updated = first.pages.get("wechat-history/history");
  assert.ok(updated);
  assert.notEqual(updated.definition, page.definition);
  assert.equal(styles.size, 1);
  const errors = t.mock.method(console, "error", () => undefined);
  await update("missing.js", "page3");
  assert.equal(
    first.pages.get("wechat-history/history")?.definition,
    updated.definition,
  );
  assert.equal(
    styles.size,
    1,
    "failed downloads keep the existing style and page",
  );
  assert.equal(first.failures[0]?.id, "wechat-history");
  const failedApply = client.replace(
    "return module.exports;",
    `module.exports.apply = (ctx) => { throw new Error("fixture apply failure"); }; return module.exports;`,
  );
  sources.set(`${endpoint}/failed-apply.js?rev=page4`, failedApply);
  await update("failed-apply.js", "page4");
  assert.equal(
    first.pages.get("wechat-history/history")?.definition.title,
    updated.definition.title,
  );
  assert.equal(
    styles.size,
    1,
    "failed apply restores the previous plugin fiber",
  );
  sources.set(`${endpoint}/wechat3.js?rev=page5`, client);
  await update("wechat3.js", "page5");
  assert.equal(first.failures.length, 0);
  assert.equal(first.pages.size, 1);
  assert.equal(styles.size, 1);
  errors.mock.restore();
  await first.close();
  assert.equal(first.pages.size, 0);
  assert.equal(styles.size, 0);
  assert.equal(watchers, 0);
  assert.equal(Reflect.has(fakeWindow, "__ModuleLoader__"), false);
  sources.delete(`${endpoint}/loader.js?rev=loader1`);
  await assert.rejects(
    startPluginHost(endpoint, () => undefined),
    /插件脚本加载失败/u,
  );
  assert.equal(
    Reflect.has(fakeWindow, "__ModuleLoader__"),
    false,
    "failed bootstrap releases the global facade",
  );
  sources.set(`${endpoint}/loader.js?rev=loader1`, loader);
  const second = await startPluginHost(endpoint, () => undefined);
  assert.equal(second.pages.size, 1);
  await second.close();
  assert.equal(styles.size, 0);
  assert.equal(watchers, 0);
});
