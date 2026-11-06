import assert from "node:assert/strict";
import test from "node:test";
import {
  createLanguageController,
  formatDate,
  formatNumber,
  languageStorageKey,
  registerCatalogs,
  resolveLocale,
} from "../src/runtime.ts";
import { pseudolocalize, validateCatalogs } from "../src/catalogs.ts";

test("system matching respects preference order, region variants and explicit choices", () => {
  assert.equal(
    resolveLocale("system", ["invalid_!", "de-DE", "ja-JP", "en-US"]),
    "ja",
  );
  assert.equal(resolveLocale("system", ["ko-KR"]), "ko");
  assert.equal(resolveLocale("system", ["zh-Hans-SG"]), "zh-CN");
  assert.equal(resolveLocale("system", ["ru-RU"]), "ru");
  assert.equal(resolveLocale("system", ["fr-CA"]), "fr");
  assert.equal(resolveLocale("system", []), "en");
  assert.equal(resolveLocale("fr", ["ja-JP"]), "fr");
});

test("only an explicit language choice writes preferences and other data stays untouched", async () => {
  const values = new Map([["aura.workspace.v1", "original history"]]);
  const writes: string[] = [];
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      writes.push(key);
      values.set(key, value);
    },
  };
  const controller = createLanguageController({
    storage,
    languages: ["zh-CN"],
  });
  await controller.ready;
  assert.deepEqual(writes, []);
  assert.equal(controller.getSnapshot().locale, "zh-CN");
  await controller.systemChanged(["ru-RU"]);
  assert.deepEqual(writes, []);
  assert.equal(controller.getSnapshot().locale, "ru");
  await controller.select("ja");
  assert.deepEqual(writes, [languageStorageKey]);
  await controller.systemChanged(["fr-FR"]);
  assert.equal(controller.getSnapshot().locale, "ja");
  assert.equal(values.get("aura.workspace.v1"), "original history");
  const restored = createLanguageController({ storage });
  await restored.ready;
  assert.equal(restored.getSnapshot().locale, "ja");
  await controller.select("system");
  assert.equal(controller.getSnapshot().locale, "fr");
  assert.deepEqual(writes, [languageStorageKey, languageStorageKey]);
  await assert.rejects(controller.select("unsupported"), /Unsupported/);
  assert.equal(writes.length, 2);
});

test("blocked or malformed preference storage still permits an in-memory language switch", async () => {
  for (const stored of ["not JSON", JSON.stringify({ language: "xx" })]) {
    const controller = createLanguageController({
      storage: {
        getItem: () => stored,
        setItem() {
          throw new Error("blocked");
        },
      },
      languages: ["ko-KR"],
    });
    await controller.ready;
    assert.equal(controller.getSnapshot().locale, "ko");
    await controller.select("fr");
    assert.equal(controller.i18n.language, "fr");
    assert.equal(controller.getSnapshot().saveError, true);
  }
});

test("catalog fallback, interpolation and Russian plurals use the selected language", async () => {
  const controller = createLanguageController({ languages: ["ru"] });
  await controller.ready;
  registerCatalogs(
    "files",
    {
      en: {
        title: "Files",
        files_one: "{{count}} file",
        files_other: "{{count}} files",
        user: "Hello {{name}}",
      },
      ru: {
        files_one: "{{count}} файл",
        files_few: "{{count}} файла",
        files_many: "{{count}} файлов",
        files_other: "{{count}} файла",
      },
    },
    controller.i18n,
  );
  const t = controller.i18n.getFixedT(null, "files");
  assert.equal(t("title"), "Files");
  assert.deepEqual(
    [1, 2, 5, 21, 1.5].map((count) => t("files", { count })),
    ["1 файл", "2 файла", "5 файлов", "21 файл", "1.5 файла"],
  );
  assert.equal(t("user", { name: "<test>" }), "Hello <test>");
  await controller.systemChanged(["en-US"]);
  assert.equal(t("files", { count: 2 }), "2 files");
});

test("catalog replacement drops stale keys and stale cleanup cannot remove the new revision", async () => {
  const controller = createLanguageController();
  await controller.ready;
  const first = registerCatalogs(
    "plugin.sample",
    { en: { title: "Old", removed: "Old only" }, ja: { title: "旧" } },
    controller.i18n,
  );
  const second = registerCatalogs(
    "plugin.sample",
    { en: { title: "New" } },
    controller.i18n,
  );
  first();
  assert.equal(controller.i18n.t("title", { ns: "plugin.sample" }), "New");
  assert.equal(
    controller.i18n.exists("removed", { ns: "plugin.sample" }),
    false,
  );
  assert.equal(controller.i18n.hasResourceBundle("ja", "plugin.sample"), false);
  second();
  assert.equal(controller.i18n.hasResourceBundle("en", "plugin.sample"), false);
});

test("malformed catalogs are rejected before replacing a working plugin revision", async () => {
  const controller = createLanguageController();
  await controller.ready;
  registerCatalogs(
    "plugin.sample",
    { en: { title: "Working" } },
    controller.i18n,
  );
  assert.throws(
    () =>
      registerCatalogs("plugin.sample", { en: { title: "" } }, controller.i18n),
    /Invalid/,
  );
  assert.equal(controller.i18n.t("title", { ns: "plugin.sample" }), "Working");
  assert.throws(
    () => validateCatalogs(JSON.parse('{"en":{"__proto__":"bad"}}')),
    /Invalid/,
  );
  assert.throws(() => validateCatalogs({ en: { nested: {} } }), /Invalid/);
  assert.throws(() => validateCatalogs({ de: {} }), /Unsupported/);
});

test("formatters keep explicit time zones and currencies while adapting display conventions", () => {
  const date = "2026-11-05T00:00:00Z";
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"] as const) {
    const options = { dateStyle: "short", timeZone: "UTC" } as const;
    assert.equal(
      formatDate(date, options, locale),
      new Intl.DateTimeFormat(locale, options).format(new Date(date)),
    );
    assert.equal(
      formatNumber(1234.5, { style: "currency", currency: "USD" }, locale),
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
      }).format(1234.5),
    );
  }
});

test("pseudo translations expand text without changing interpolation or markup", () => {
  const source = "Hello <strong>{{name}}</strong>";
  const result = pseudolocalize({ greeting: source }).greeting;
  assert.ok(result.length > source.length);
  assert.ok(result.includes("<strong>{{name}}</strong>"));
});
