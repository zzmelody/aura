import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { auditCatalogs, type TranslationCatalogs } from "@aura/i18n/catalogs";
import { locales } from "@aura/i18n/runtime";
import { isPluginLocalization } from "@aura/protocol/localization";

test("desktop catalogs cover the same six languages and message contracts", async () => {
  const catalogs: TranslationCatalogs = {};
  for (const locale of locales)
    catalogs[locale] = JSON.parse(
      await readFile(
        new URL(`../apps/desktop/src/locales/${locale}.json`, import.meta.url),
        "utf8",
      ),
    );
  assert.deepEqual(auditCatalogs(catalogs), []);
});

test("host catalogs cover six languages, their plural categories and interpolation values", async () => {
  const root = new URL(
    "../packages/frontend/workbench/src/locales/",
    import.meta.url,
  );
  const files = (await readdir(new URL("en/", root))).filter((file) =>
    file.endsWith(".json"),
  );
  for (const file of files) {
    const catalogs: TranslationCatalogs = {};
    for (const locale of locales)
      catalogs[locale] = JSON.parse(
        await readFile(new URL(`${locale}/${file}`, root), "utf8"),
      );
    assert.deepEqual(auditCatalogs(catalogs), [], file);
  }
});

test("product plugin catalogs cover six languages without relying on host messages", async () => {
  for (const plugin of ["tripo", "site-launcher"]) {
    const manifest = JSON.parse(
      await readFile(
        new URL(`../plugins/${plugin}/aura.plugin.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      isPluginLocalization(manifest.localization),
      `${plugin}: static metadata`,
    );
    assert.deepEqual(
      auditCatalogs(manifest.localization.catalogs),
      [],
      `${plugin}: metadata catalogs`,
    );
    const catalogs: TranslationCatalogs = {};
    for (const locale of locales) {
      const path = new URL(
        `../plugins/${plugin}/client/src/locales/${locale}.json`,
        import.meta.url,
      );
      catalogs[locale] = JSON.parse(await readFile(path, "utf8"));
    }
    assert.deepEqual(auditCatalogs(catalogs), [], plugin);
  }
});
