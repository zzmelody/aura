import assert from "node:assert/strict";
import test from "node:test";
import { isPluginLocalization } from "../src/localization.ts";

test("plugin metadata accepts static display keys and rejects executable or schema-changing data", () => {
  const valid = {
    catalogs: {
      en: { name: "Name", title: "Title", label: "Label" },
      fr: { name: "Nom" },
    },
    nameKey: "name",
    flows: {
      report: {
        titleKey: "title",
        input: {
          "/properties/a~1b~0c": { titleKey: "label", enumKeys: ["label"] },
        },
      },
    },
  };
  assert.equal(isPluginLocalization(valid), true);
  for (const value of [
    null,
    [],
    "locales.json",
    { ...valid, url: "https://invalid.test/catalog" },
    { ...valid, nameKey: "missing" },
    { ...valid, catalogs: { fr: { name: "Nom" } } },
    { ...valid, catalogs: { en: { name: 123 } } },
    { ...valid, catalogs: { en: { name: "Name" }, de: { name: "Name" } } },
    { ...valid, catalogs: { en: JSON.parse('{"__proto__":"unsafe"}') } },
    { ...valid, catalogs: { en: { name: "x".repeat(4_001) } } },
    { ...valid, flows: { "another.plugin/report": { titleKey: "title" } } },
    {
      ...valid,
      flows: {
        report: { input: { "properties/name": { titleKey: "title" } } },
      },
    },
    {
      ...valid,
      flows: {
        report: { input: { "/properties/a~2": { titleKey: "title" } } },
      },
    },
    {
      ...valid,
      flows: {
        report: { input: { "/properties/name": { default: "changed" } } },
      },
    },
    {
      ...valid,
      actions: { report: { input: { "": { enumKeys: ["missing"] } } } },
    },
  ])
    assert.equal(isPluginLocalization(value), false);
  const catalogs = {
    en: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`key${i}`, "x".repeat(4_000)]),
    ),
  };
  assert.equal(isPluginLocalization({ catalogs }), false);
});
