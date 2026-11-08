import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Context } from "@deepseek-ai/cordis";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { language } from "@aura/i18n/runtime";
import {
  installSecretMask,
  secretMaskSnapshot,
  secretSegments,
  SecretMaskRuntime,
} from "../src/features/coding/secret-mask.ts";

const require = createRequire(import.meta.url);

async function nativePlugin() {
  let plugin: { apply(ctx: Context): void } | undefined;
  const source = await readFile(
    require.resolve("@deepseek-ai/dsh-client-ui-secret-mask/client"),
    "utf8",
  );
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(bundle: { factory(require: NodeJS.Require): typeof plugin }) {
          plugin = bundle.factory(require);
        },
      },
    },
  });
  assert.ok(plugin);
  return plugin;
}

test("local mask initialization is shared, retries finitely and keeps a working instance across failed replacement", async (t) => {
  const plugin = await nativePlugin();
  let calls = 0;
  let fail = false;
  const runtime = new SecretMaskRuntime(async () => {
    calls++;
    if (calls <= 2 || fail) throw new Error("Synthetic asset failure");
    return plugin;
  }, [0, 0]);
  t.after(() => runtime.dispose());
  const first = runtime.initialize();
  assert.equal(runtime.initialize(), first);
  await first;
  assert.equal(calls, 3);
  const original = runtime.snapshot().mask;
  assert.ok(original);
  await runtime.initialize();
  assert.equal(calls, 3);
  const snapshots: unknown[] = [];
  const unsubscribe = runtime.subscribe(() =>
    snapshots.push(runtime.snapshot().mask),
  );
  t.after(unsubscribe);
  fail = true;
  await runtime.initialize(true);
  assert.equal(calls, 6);
  assert.equal(runtime.snapshot().phase, "failed");
  assert.equal(runtime.snapshot().mask, original);
  assert.ok(snapshots.every((mask) => mask === original));
  fail = false;
  await runtime.initialize(true);
  assert.equal(calls, 7);
  assert.equal(runtime.snapshot().phase, "ready");
  assert.notEqual(runtime.snapshot().mask, original);
});

test("a failed native registration retains the previous mask and disposing an in-flight load cancels retries", async (t) => {
  const plugin = await nativePlugin();
  let invalid = false;
  const runtime = new SecretMaskRuntime(
    async () => (invalid ? { apply() {} } : plugin),
    [],
  );
  t.after(() => runtime.dispose());
  await runtime.initialize();
  const original = runtime.snapshot().mask;
  invalid = true;
  await runtime.initialize(true);
  assert.equal(runtime.snapshot().phase, "failed");
  assert.equal(runtime.snapshot().mask, original);
  let attempts = 0;
  const pending = new SecretMaskRuntime(
    (signal) =>
      new Promise((_resolve, reject) => {
        attempts++;
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
    [0, 0],
  );
  const opening = pending.initialize();
  await pending.dispose();
  await opening;
  assert.equal(attempts, 1);
  assert.deepEqual(pending.snapshot(), { phase: "idle" });
});
test("published DSH matcher and renderer mask credentials while preserving the original message", async () => {
  let factory:
    ((require: NodeJS.Require) => { apply(ctx: Context): void }) | undefined;
  const source = await readFile(
    require.resolve("@deepseek-ai/dsh-client-ui-secret-mask/client"),
    "utf8",
  );
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(bundle: { factory: typeof factory }) {
          factory = bundle.factory;
        },
      },
    },
  });
  assert.ok(factory);
  const root = new Context();
  const plugin = root.plugin((ctx) =>
    installSecretMask(ctx, factory!(require)),
  );
  await plugin.await();
  try {
    const mask = secretMaskSnapshot();
    assert.ok(mask);
    const credential = `ghp_${"a".repeat(36)}`;
    const raw = `汉字😀 first ${credential} then https://user:synthetic-password@example.com/path end`;
    const segments = secretSegments(raw, mask.rule);
    assert.equal(segments.map((segment) => segment.text).join(""), raw);
    const matches = segments.filter((segment) => segment.node);
    assert.equal(matches.length, 2);
    for (const segment of matches) {
      const html = renderToStaticMarkup(
        React.createElement(mask.render, {
          node: segment.node!,
          raw: segment.text,
          interactive: true,
          t: mask.translate,
        }),
      );
      assert.ok(!html.includes(credential));
      assert.ok(!html.includes("synthetic-password"));
      assert.ok(html.includes(mask.translate("secret.reveal")));
      assert.match(html, /aria-pressed="false"/u);
    }
    assert.deepEqual(secretSegments("ordinary text", mask.rule), [
      { text: "ordinary text" },
    ]);
    const expected = {
      "zh-CN": "显示密钥",
      en: "Show secret",
      ja: "シークレットを表示",
      ko: "비밀 정보 표시",
      ru: "Показать секрет",
      fr: "Afficher le secret",
    };
    for (const [locale, label] of Object.entries(expected)) {
      await language.systemChanged([locale]);
      assert.equal(mask.translate("secret.reveal"), label);
      assert.equal(secretMaskSnapshot(), mask);
      assert.equal(
        secretSegments(raw, mask.rule)
          .map((part) => part.text)
          .join(""),
        raw,
      );
    }
  } finally {
    await plugin.dispose();
  }
  assert.equal(secretMaskSnapshot(), undefined);
});
