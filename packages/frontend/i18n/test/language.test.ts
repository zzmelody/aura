import assert from "node:assert/strict";
import test from "node:test";
import {
  createLanguageController,
  errorMessage,
  formatDate,
  formatNumber,
  language,
  languageStorageKey,
  messageText,
  MessageError,
  registerCatalogs,
  resolveLocale,
} from "../src/runtime.ts";
import {
  auditCatalogs,
  pseudolocalize,
  validateCatalogs,
} from "../src/catalogs.ts";

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

test("inline plugin messages follow the requested locale even when registered catalogs fall back to English", async () => {
  const controller = createLanguageController({ languages: ["en"] });
  controller.i18n.addResourceBundle("en", "fixture", {
    text: "English catalog fallback",
  });
  await controller.select("ja");
  assert.equal(
    controller.i18n.t("text", { ns: "fixture" }),
    "English catalog fallback",
  );
  const message = {
    namespace: "pluginErrors",
    key: "failure",
    translations: { en: "English literal {{name}}", ja: "日本語 {{name}}" },
  };
  assert.equal(messageText(message, controller.i18n), "日本語 {{name}}");
  await controller.select("ko");
  assert.equal(
    messageText(message, controller.i18n),
    "English literal {{name}}",
  );
});

test("async failures retain nested message identities across a language change", async () => {
  const controller = createLanguageController({ languages: ["en"] });
  await controller.ready;
  registerCatalogs(
    "errors",
    {
      en: {
        send: "Unable to send: {{reason}}",
        limit: "Limit: {{size, number}} bytes",
      },
      fr: {
        send: "Envoi impossible : {{reason}}",
        limit: "Limite : {{size, number}} octets",
      },
    },
    controller.i18n,
  );
  let retained;
  try {
    await Promise.reject(
      new MessageError({
        namespace: "errors",
        key: "limit",
        values: { size: 1234 },
      }),
    );
  } catch (error) {
    retained = {
      namespace: "errors",
      key: "send",
      values: { reason: errorMessage(error) },
    };
  }
  assert.ok(retained);
  assert.equal(
    messageText(retained, controller.i18n),
    "Unable to send: Limit: 1,234 bytes",
  );
  await controller.systemChanged(["fr"]);
  assert.equal(
    messageText(retained, controller.i18n),
    `Envoi impossible : Limite : ${new Intl.NumberFormat("fr").format(1234)} octets`,
  );
  assert.equal(errorMessage(new Error("Original 原文")), "Original 原文");
  assert.equal(
    errorMessage(new MessageError("Original 原文")),
    "Original 原文",
  );
  assert.equal(errorMessage(null, "Fallback"), "Fallback");
});

test("localized errors retain their cause and a readable message for legacy consumers", async (t) => {
  await language.ready;
  const original = language.getSnapshot().locale;
  t.after(() => language.systemChanged([original]));
  const dispose = registerCatalogs("error-compatibility", {
    en: { failed: "Could not read {{name}}." },
    fr: { failed: "Impossible de lire {{name}}." },
  });
  t.after(dispose);
  await language.systemChanged(["en"]);
  const text = {
    namespace: "error-compatibility",
    key: "failed",
    values: { name: "Original 原文" },
  };
  const cause = new Error("Synthetic network error");
  const error = new MessageError(text, { cause });
  assert.equal(error.message, "Could not read Original 原文.");
  assert.equal(error.cause, cause);
  assert.equal(errorMessage(error), text);
  await language.systemChanged(["fr"]);
  assert.equal(
    messageText(errorMessage(error)),
    "Impossible de lire Original 原文.",
  );
  assert.equal(error.message, "Could not read Original 原文.");
  assert.equal(
    new MessageError(text).message,
    "Impossible de lire Original 原文.",
  );
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

test("catalog audits catch missing plural forms and renamed interpolation values", () => {
  const issues = auditCatalogs(
    {
      en: {
        files_one: "{{count}} file",
        files_other: "{{count}} files",
        name: "Hello {{name}}",
      },
      ru: {
        files_one: "{{count}} файл",
        files_other: "{{count}} файла",
        name: "Привет {{user}}",
      },
    },
    ["en", "ru", "ja"],
  );
  assert.deepEqual(
    issues.sort(),
    [
      "Missing catalog: ja",
      "ru: interpolation mismatch for name",
      "ru: missing files_few",
      "ru: missing files_many",
    ].sort(),
  );
});

test("retained UI messages change language without translating user supplied values", async () => {
  const controller = createLanguageController({ languages: ["en"] });
  await controller.ready;
  registerCatalogs(
    "notice",
    { en: { saved: "Saved {{title}}" }, fr: { saved: "{{title}} enregistré" } },
    controller.i18n,
  );
  const message = {
    namespace: "notice",
    key: "saved",
    values: { title: "我的草稿" },
  };
  assert.equal(messageText(message, controller.i18n), "Saved 我的草稿");
  await controller.systemChanged(["fr"]);
  assert.equal(messageText(message, controller.i18n), "我的草稿 enregistré");
  assert.equal(messageText("User content", controller.i18n), "User content");
});
