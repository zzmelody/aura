import assert from "node:assert/strict";
import test from "node:test";
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
