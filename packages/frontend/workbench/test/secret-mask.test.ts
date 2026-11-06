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
} from "../src/features/coding/secret-mask.ts";

const require = createRequire(import.meta.url);
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
