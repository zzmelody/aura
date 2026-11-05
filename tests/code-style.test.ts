import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";
import { checkFormat, formatHash } from "../scripts/check-format.ts";

test("lint config enforces new TypeScript violations without reading the legacy baseline", async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(
    "export type bad_name = any; export let count = 1; export default count;",
    { filePath: "packages/shared/protocol/src/style-probe.ts" },
  );
  const rules = new Set(result.messages.map((message) => message.ruleId));
  assert.ok(rules.has("@typescript-eslint/no-explicit-any"));
  assert.ok(rules.has("@typescript-eslint/naming-convention"));
  assert.ok(rules.has("no-restricted-syntax"));
});

test("lint config checks Hook placement and stale dependencies in the shared React UI", async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(
    `import { useEffect } from 'react';
     export function Example({ value }: { value: number }) {
       if (value) useEffect(() => { console.log(value); }, []);
       return null;
     }`,
    { filePath: "packages/frontend/workbench/src/StyleProbe.tsx" },
  );
  const rules = new Set(result.messages.map((message) => message.ruleId));
  assert.ok(rules.has("react-hooks/rules-of-hooks"));
  assert.ok(rules.has("react-hooks/exhaustive-deps"));
});

test("host and product plugin lint configs coexist without losing TypeScript or React checks", async () => {
  const eslint = new ESLint();
  for (const filePath of [
    "packages/shared/protocol/src/style-probe.ts",
    "plugins/site-launcher/backend/style-probe.ts",
    "plugins/tripo/backend/style-probe.ts",
  ]) {
    const [result] = await eslint.lintText("export type Value = any;", {
      filePath,
    });
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === "@typescript-eslint/no-explicit-any",
      ),
    );
  }
  const [browser] = await eslint.lintText(
    `import { useEffect } from 'react';
     export function Example({ value }: { value: string }) {
       if (value) useEffect(() => { document.title = value; }, []);
       return null;
     }`,
    { filePath: "plugins/tripo/client/src/StyleProbe.tsx" },
  );
  assert.equal(browser.fatalErrorCount, 0, JSON.stringify(browser.messages));
  const rules = new Set(browser.messages.map((message) => message.ruleId));
  assert.ok(rules.has("react-hooks/rules-of-hooks"));
  assert.ok(rules.has("react-hooks/exhaustive-deps"));
  assert.ok(!rules.has("no-undef"), "plugin UI keeps its browser globals");
});

test("format gate allows unchanged legacy code but rejects edited and new violations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-format-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".prettierignore"), "generated/\n");
  await writeFile(join(root, ".prettierrc.json"), '{"singleQuote":false}\n');
  await mkdir(join(root, "generated"));
  const old = "export const value=1\n";
  await writeFile(join(root, "old.ts"), old);
  await writeFile(join(root, "new.ts"), "export const other=2\n");
  await writeFile(join(root, "generated", "ignored.ts"), "broken {{{");
  await writeFile(join(root, "asset.bin"), Buffer.from([0, 1, 2]));
  const files = [
    "old.ts",
    "new.ts",
    "generated/ignored.ts",
    "asset.bin",
    "deleted.ts",
  ];
  const baseline = { "old.ts": formatHash(old) };
  assert.deepEqual(await checkFormat(root, files, baseline), {
    violations: ["new.ts"],
    legacy: 1,
  });
  await writeFile(join(root, "old.ts"), "export const value=3\n");
  assert.deepEqual((await checkFormat(root, files, baseline)).violations, [
    "old.ts",
    "new.ts",
  ]);
  await writeFile(join(root, "old.ts"), "export const value = 3;\n");
  await writeFile(join(root, "new.ts"), "export const other = 2;\n");
  assert.deepEqual(await checkFormat(root, files, baseline), {
    violations: [],
    legacy: 0,
  });
});

test("format baseline and gate survive Git checkout line endings", async (t) => {
  assert.equal(formatHash("a\r\nb\r\n"), formatHash("a\nb\n"));
  const root = await mkdtemp(join(tmpdir(), "aura-format-eol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".prettierignore"), "");
  await writeFile(join(root, "index.ts"), "export const value = 1;\r\n");
  assert.deepEqual(await checkFormat(root, ["index.ts"], {}), {
    violations: [],
    legacy: 0,
  });
});
