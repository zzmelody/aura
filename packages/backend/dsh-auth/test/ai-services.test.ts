import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  CodexSubscriptionAuth,
  readAiServices,
  saveModelSettings,
  customProfiles,
  parseModelSettings,
  saveDiscoveredCatalog,
  selectedAgentConfig,
  LUMINA_BASE_URL,
  LUMINA_CREDENTIAL,
  LUMINA_PROVIDER,
} from "@aura/dsh-auth";

const settings = {
  mode: "custom",
  model: "fixture-model",
  reasoningEffort: "off",
  custom: {
    name: "Fixture gateway",
    api: "openai-completions",
    baseURL: "https://fixture.example/v1",
    images: true,
    contextWindow: 262144,
  },
};

test("DeepSeek Flash thinking reserves 64K for reasoning plus final output",async t=>{
  const root=await mkdtemp(join(tmpdir(),"aura-ds-output-"));
  const auth=await CodexSubscriptionAuth.create({credentialPath:join(root,".aura","dsh",".credentials.yaml")});
  t.after(async()=>{await auth.close();await rm(root,{recursive:true,force:true});});
  const high=await saveModelSettings(root,auth.ctx.credentials,{...settings,model:"deepseek-v4.1-flash-anthropic",reasoningEffort:"high",key:"fixture-only-key"});
  assert.equal(selectedAgentConfig(high).maxTokens,65536);
  assert.equal(customProfiles(high)[high.selectedRoute!]!.models![0]!.maxTokens,65536);
  const off=await saveModelSettings(root,auth.ctx.credentials,{...settings,model:"deepseek-v4.1-flash-anthropic",reasoningEffort:"off"});
  assert.equal(selectedAgentConfig(off).maxTokens,undefined);
  assert.equal(customProfiles(off)[off.selectedRoute!]!.models![0]!.maxTokens,undefined);
});

test("custom configuration pins endpoint and credentials without persisting keys in public settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-ai-settings-"));
  const auth = await CodexSubscriptionAuth.create({
    credentialPath: join(root, ".aura", "dsh", ".credentials.yaml"),
  });
  t.after(async () => {
    await auth.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await saveModelSettings(root, auth.ctx.credentials, {
    ...settings,
    key: "fixture-key-one",
  });
  const original = first.routes[first.selectedRoute!]!;
  const second = await saveModelSettings(root, auth.ctx.credentials, {
    ...settings,
    model: "fixture-new-model",
    key: "fixture-key-two",
  });
  assert.notEqual(first.selectedRoute, second.selectedRoute);
  assert.deepEqual(second.routes[first.selectedRoute!], original);
  assert.equal(
    (await auth.ctx.credentials.resolve(credentialRef(original.credential)))
      ?.value,
    "fixture-key-one",
  );
  const newRef = second.routes[second.selectedRoute!]!.credential;
  assert.equal(
    (await auth.ctx.credentials.resolve(credentialRef(newRef)))?.value,
    "fixture-key-two",
  );
  const saved = await readFile(join(root, ".aura", "ai-services.json"), "utf8");
  assert.ok(!saved.includes("fixture-key"));
  assert.equal(
    customProfiles(second)[first.selectedRoute!]?.baseURL,
    settings.custom.baseURL,
  );
  const switched = await saveModelSettings(root, auth.ctx.credentials, {
    mode: "codex",
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
  });
  assert.equal(switched.selectedRoute, second.selectedRoute);
  assert.equal((await readAiServices(root)).model.mode, "codex");
});

test("keys are retained only for the same endpoint, and explicit clear removes all retained custom keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-ai-keys-"));
  const auth = await CodexSubscriptionAuth.create({
    credentialPath: join(root, ".aura", "dsh", ".credentials.yaml"),
  });
  t.after(async () => {
    await auth.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await saveModelSettings(root, auth.ctx.credentials, {
    ...settings,
    key: "fixture-private",
  });
  const inherited = await saveModelSettings(
    root,
    auth.ctx.credentials,
    settings,
  );
  assert.equal(
    (
      await auth.ctx.credentials.resolve(
        credentialRef(inherited.routes[inherited.selectedRoute!]!.credential),
      )
    )?.value,
    "fixture-private",
  );
  const changed = await saveModelSettings(root, auth.ctx.credentials, {
    ...settings,
    custom: { ...settings.custom, baseURL: "https://other.example/v1" },
  });
  assert.equal(
    (
      await auth.ctx.credentials.describe(
        credentialRef(changed.routes[changed.selectedRoute!]!.credential),
      )
    ).configured,
    false,
  );
  const cleared = await saveModelSettings(root, auth.ctx.credentials, {
    ...settings,
    clearKey: true,
  });
  for (const entry of Object.values(cleared.routes))
    assert.equal(
      (await auth.ctx.credentials.describe(credentialRef(entry.credential)))
        .configured,
      false,
    );
  assert.equal(
    cleared.routes[first.selectedRoute!]!.settings.model,
    settings.model,
  );
});

test("provider settings reject credential URLs, unsupported fields and Codex API keys", () => {
  for (const baseURL of [
    "http://remote.example/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?key=hidden",
    "file:///private",
  ]) {
    assert.throws(() =>
      parseModelSettings({
        ...settings,
        custom: { ...settings.custom, baseURL },
      }),
    );
  }
  assert.throws(() => parseModelSettings({ ...settings, key: "bad\nkey" }));
  assert.throws(() =>
    parseModelSettings({ ...settings, key: "valid", clearKey: true }),
  );
  assert.throws(() =>
    parseModelSettings({
      ...settings,
      custom: { ...settings.custom, headers: { authorization: "private" } },
    }),
  );
  assert.throws(() =>
    parseModelSettings({
      mode: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      key: "private",
    }),
  );
  assert.equal(
    parseModelSettings({
      ...settings,
      custom: {
        ...settings.custom,
        baseURL: "http://127.0.0.1:1234/v1",
      },
    }).custom?.baseURL,
    "http://127.0.0.1:1234/v1",
  );
});

test("Lumina keeps one stable route, stores its key only in DSH credentials, and registers discovered models", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-ai-lumina-"));
  const auth = await CodexSubscriptionAuth.create({
    credentialPath: join(root, ".aura", "dsh", ".credentials.yaml"),
  });
  t.after(async () => {
    await auth.close();
    await rm(root, { recursive: true, force: true });
  });
  const ref = credentialRef(LUMINA_CREDENTIAL);
  const saved = await saveModelSettings(root, auth.ctx.credentials, {
    mode: "lumina",
    model: "claude-sonnet-4-6",
    reasoningEffort: "high",
    key: "lumina-private",
  });
  assert.equal((await auth.ctx.credentials.resolve(ref))?.value, "lumina-private");
  assert.equal(selectedAgentConfig(saved).provider, LUMINA_PROVIDER);
  assert.ok(!(await readFile(join(root, ".aura", "ai-services.json"), "utf8")).includes("lumina-private"));
  await saveDiscoveredCatalog(root, "lumina", ["claude-sonnet-4-6", "deepseek-v4-flash", "gpt-5.5"]);
  const profile = customProfiles(await readAiServices(root))[LUMINA_PROVIDER]!;
  assert.equal(profile.baseURL, LUMINA_BASE_URL);
  assert.equal(profile.apiKeyEnv, LUMINA_CREDENTIAL);
  assert.deepEqual(profile.models?.map(({ id }) => id), ["claude-sonnet-4-6", "deepseek-v4-flash", "gpt-5.5"]);
  assert.deepEqual(profile.models?.find(({ id }) => id === "deepseek-v4-flash")?.input, ["text"]);
  assert.throws(() => parseModelSettings({ mode: "lumina", model: "m", reasoningEffort: "high", custom: {} }));
  await saveModelSettings(root, auth.ctx.credentials, {
    mode: "lumina",
    model: "gpt-5.5",
    reasoningEffort: "high",
    clearKey: true,
  });
  assert.equal((await auth.ctx.credentials.describe(ref)).configured, false);
  assert.equal((await readAiServices(root)).lumina?.models.length, 3);
});
