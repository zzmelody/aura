import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { startPluginHost } from "../src/pluginHost.ts";
import { migratedStudioTab } from "../src/studio-navigation.ts";

test("legacy workbench shortcuts resolve to product plugin pages", () => {
  assert.equal(
    migratedStudioTab("studio:content"),
    "plugin:self-media/content",
  );
  assert.equal(migratedStudioTab("studio:video"), "plugin:self-media/video");
  assert.equal(
    migratedStudioTab("studio:research"),
    "plugin:self-media/topics",
  );
  assert.equal(migratedStudioTab("site"), "plugin:site-launcher/sites");
  assert.equal(migratedStudioTab("studio:coding"), "studio:coding");
});

test("built product bundles mount four pages through DSH and dispose their styles", async (t) => {
  const workspace = new URL("../../../../", import.meta.url);
  const require = createRequire(
    new URL("packages/backend/runtime/package.json", workspace),
  );
  const loaderId = "@deepseek-ai/dsh-client-modules";
  const sources = new Map<string, string>([
    [
      "http://fixture.invalid/loader.js",
      await readFile(require.resolve(`${loaderId}/client`), "utf8"),
    ],
  ]);
  for (const id of ["self-media", "site-launcher"])
    sources.set(
      `http://fixture.invalid/${id}.js`,
      await readFile(
        new URL(`plugins/${id}/client/dist/client.js`, workspace),
        "utf8",
      ),
    );
  const entries = [
    { id: loaderId, url: "loader.js", rev: "loader1", immediately: true },
    ...["self-media", "site-launcher"].map((id) => ({
      id,
      url: `${id}.js`,
      rev: "v1",
      external: [
        "react",
        "react/jsx-runtime",
        "@aura/plugin-ui",
        "@aura/workbench/plugin",
        "@aura/workbench/transport",
      ],
    })),
  ];
  const graph = {
    rev: "v1",
    entries,
    batches: entries.map((entry) => ({
      phase: entry.id === loaderId ? "bootstrap" : "application",
      url: entry.url,
      rev: entry.rev,
      entries: [entry.id],
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
  const replacements = {
    window: {},
    document: {
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
              runInThisContext(source);
              element.onload?.();
            } catch {
              element.onerror?.();
            }
          });
        },
      },
      querySelectorAll: () => [...styles],
    },
    EventSource: class {
      addEventListener() {}
      close() {}
    },
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
      configurable: true,
      writable: true,
    });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const host = await startPluginHost(
    "http://fixture.invalid",
    () => undefined,
    {
      // Shared workflow widgets are supplied by the renderer; initial empty pages do not use them.
      platform: () => "web",
      siteDialogsAvailable: () => false,
      NestedFlowRun: () => null,
      WorkflowControls: () => null,
      WorkflowVideoResult: () => null,
    },
  );
  t.after(() => host.close());
  assert.deepEqual(host.failures, []);
  assert.deepEqual([...host.pages.keys()].sort(), [
    "self-media/content",
    "self-media/topics",
    "self-media/video",
    "site-launcher/sites",
  ]);
  assert.equal(styles.size, 2);
  for (const [id, page] of host.pages) {
    const html = renderToStaticMarkup(
      page.definition.render({
        endpoint: "http://fixture.invalid",
        pluginId: page.pluginId,
        invoke: async () => null,
        onBack: () => undefined,
        onDirtyChange: () => undefined,
      }),
    );
    assert.ok(html.length > 100, id);
  }
  await host.close();
  assert.equal(styles.size, 0);
  assert.equal(host.pages.size, 0);
});
