import assert from "node:assert/strict";
import test from "node:test";
import { createLanguageController, locales } from "@aura/i18n/runtime";
import {
  MetadataOwner,
  flowTitle,
  flowDescription,
  metadataText,
  metadataEnumLabel,
} from "../src/metadata.ts";
import { catalog, settings, metadata } from "./fixtures/metadata.ts";
import { filterFlows } from "../src/flowPicker.ts";
import { workflowFieldKind } from "../src/workflowInputModel.ts";
import type { JsonValue } from "@aura/protocol/types";

test("manifest metadata uses live scoped i18next catalogs while serialized identities, schemas and enum values remain unchanged", async (t) => {
  const controller = createLanguageController({ languages: ["en"] });
  await controller.ready;
  const owner = new MetadataOwner(controller.i18n);
  t.after(() => owner.dispose());
  const view = owner.catalog(catalog);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), catalog);
  const flow = view.flows[0];
  const properties = (flow.inputSchema as Record<string, JsonValue>)
    .properties as Record<string, Record<string, JsonValue>>;
  for (const locale of locales) {
    await controller.systemChanged([locale]);
    assert.equal(flowTitle(flow), metadata.catalogs[locale]!.title);
    assert.equal(flowDescription(flow), metadata.catalogs[locale]!.description);
    assert.equal(flowTitle(view.actions![0]), metadata.catalogs[locale]!.title);
    assert.equal(
      metadataText(properties.prompt, "title", "fallback"),
      metadata.catalogs[locale]!.prompt,
    );
    assert.equal(
      metadataText(properties.prompt, "placeholder", "fallback"),
      metadata.catalogs[locale]!.hint,
    );
    assert.equal(
      metadataEnumLabel(properties.mode, 0, "brief"),
      metadata.catalogs[locale]!.short,
    );
    assert.equal(
      metadataText(properties["a/b~c"], "title", "fallback"),
      metadata.catalogs[locale]!.prompt,
    );
    assert.equal(workflowFieldKind("a/b~c", properties["a/b~c"]), "image");
    assert.deepEqual(
      filterFlows(view.flows, metadata.catalogs[locale]!.title),
      [flow],
    );
    assert.equal(flow.title, "Original flow");
    assert.deepEqual(properties.mode.enum, ["brief", "full"]);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(view)), catalog);
  const unknownOwner = {
    ...catalog,
    flows: [
      {
        ...catalog.flows[0],
        plugin: { id: "foreign", name: "Other", version: "1.0.0" },
      },
    ],
  };
  assert.equal(
    flowTitle(owner.catalog(unknownOwner).flows[0]),
    "Original flow",
  );
});

test("metadata resources replace deleted keys, fall back to English and remain isolated until their reader is disposed", async () => {
  const controller = createLanguageController({ languages: ["fr"] });
  const first = new MetadataOwner(controller.i18n);
  const second = new MetadataOwner(controller.i18n);
  try {
    const one = first.catalog(catalog);
    const changed = structuredClone(settings);
    changed.plugins[0].status.localization = {
      catalogs: { en: { name: "Literal {{name}} $t(other)" } },
      nameKey: "name",
    };
    const two = second.settings(changed);
    assert.equal(
      metadataText(two.plugins[0].status, "name", "fallback"),
      "Literal {{name}} $t(other)",
    );
    assert.equal(flowTitle(one.flows[0]), metadata.catalogs.fr!.title);
    first.catalog({ ...catalog, plugins: [], flows: [] });
    assert.equal(flowTitle(one.flows[0]), "Original flow");
    assert.equal(
      metadataText(two.plugins[0].status, "name", "fallback"),
      "Literal {{name}} $t(other)",
    );
    first.dispose();
    assert.equal(
      first.catalog(catalog),
      catalog,
      "late responses cannot resurrect disposed resources",
    );
    first.activate();
    assert.equal(
      flowTitle(first.catalog(catalog).flows[0]),
      metadata.catalogs.fr!.title,
    );
    second.dispose();
    assert.equal(
      metadataText(two.plugins[0].status, "name", "Original plugin"),
      "Original plugin",
    );
  } finally {
    first.dispose();
    second.dispose();
  }
  assert.deepEqual(Object.keys(controller.i18n.store.data.en ?? {}), []);
});
