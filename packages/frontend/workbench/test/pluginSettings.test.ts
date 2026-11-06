import assert from "node:assert/strict";
import test from "node:test";
import { errorMessage, language, messageText } from "@aura/i18n/runtime";
import {
  editablePluginEntries,
  readPluginSettings,
  savePluginSettings,
} from "../src/pluginSettings.ts";

const state = {
  configPath: "F:\\aura\\.aura\\plugins.json",
  plugins: [
    {
      path: "F:/creative/aura-plugin",
      enabled: true,
      trust: "local" as const,
      status: {
        id: "veya",
        name: "Veya Creative",
        version: "0.1.1",
        enabled: true,
        available: true,
      },
    },
  ],
  active: [],
  applyRequired: true,
};

test("plugin settings transport reads and replaces the trusted directory list", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return Response.json(state);
  };

  assert.deepEqual(
    await readPluginSettings("http://127.0.0.1:4311/", undefined, fetcher),
    state,
  );
  const update = { plugins: editablePluginEntries(state) };
  assert.deepEqual(
    await savePluginSettings("http://127.0.0.1:4311", update, fetcher),
    state,
  );
  assert.equal(requests[0]?.input, "http://127.0.0.1:4311/plugins/config");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), update);
});

test("plugin settings transport surfaces sanitized backend failures", async () => {
  await assert.rejects(
    readPluginSettings("http://127.0.0.1:4311", undefined, async () =>
      Response.json({ message: "仅限本机配置。" }, { status: 403 }),
    ),
    /仅限本机配置/,
  );
});

test("plugin directory failures retain read and save identities across language changes", async () => {
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return new Response("unavailable", { status: 503 });
  };
  const read = await readPluginSettings(
    "https://fixture.invalid",
    undefined,
    fetcher,
  ).then(() => assert.fail("read must fail"), errorMessage);
  const save = await savePluginSettings(
    "https://fixture.invalid",
    { plugins: [] },
    fetcher,
  ).then(() => assert.fail("save must fail"), errorMessage);
  assert.deepEqual(read, {
    namespace: "plugins",
    key: "settingsReadFailed",
    values: { status: 503 },
  });
  assert.deepEqual(save, {
    namespace: "plugins",
    key: "settingsSaveFailed",
    values: { status: 503 },
  });
  const texts = new Set<string>();
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
    await language.systemChanged([locale]);
    for (const message of [read, save]) {
      const text = messageText(message);
      assert.ok(text.includes("503"));
      texts.add(text);
    }
  }
  assert.equal(texts.size, 12);
  assert.equal(requests, 2);
});
