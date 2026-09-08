import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshCodexAuthorization } from "@aura/dsh-codex";

test("DSH registers an openai-codex authorization flow without network access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-dsh-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorization = await DshCodexAuthorization.create({
    credentialPath: join(root, ".credentials.yaml"),
  });
  t.after(() => authorization.close());
  assert.deepEqual(await authorization.status(), {
    state: "signed_out",
    model: "gpt-5.6-terra",
  });
});

test("Aura can complete DSH's manual browser callback prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-dsh-codex-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorization = await DshCodexAuthorization.create({
    credentialPath: join(root, ".credentials.yaml"),
  });
  t.after(() => authorization.close());

  const service = authorization.ctx.authorization;
  const originalBegin = service.begin;
  const callbackHostWasSet = Object.hasOwn(
    process.env,
    "PI_OAUTH_CALLBACK_HOST",
  );
  const callbackHostBefore = process.env.PI_OAUTH_CALLBACK_HOST;
  let submitted = "";
  service.begin = async ({ interaction, signal }) => {
    const method = await interaction.prompt({
      kind: "select",
      message: "Choose login method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device_code", label: "Device code" },
      ],
      signal,
    });
    assert.equal(method, "browser");
    interaction.notify({
      message: "Open browser",
      url: "https://auth.openai.com/oauth/authorize?test=true",
    });
    submitted = await interaction.prompt({
      kind: "text",
      message: "Paste callback URL",
      placeholder: "http://localhost:1455/auth/callback?...",
      signal,
    });
    return { status: "cancelled" };
  };
  t.after(() => {
    service.begin = originalBegin;
    if (!callbackHostWasSet || callbackHostBefore === undefined)
      delete process.env.PI_OAUTH_CALLBACK_HOST;
    else process.env.PI_OAUTH_CALLBACK_HOST = callbackHostBefore;
  });

  const pending = await authorization.startLogin("browser");
  assert.equal(process.env.PI_OAUTH_CALLBACK_HOST, "localhost");
  assert.deepEqual(pending, {
    state: "pending",
    method: "browser",
    authUrl: "https://auth.openai.com/oauth/authorize?test=true",
    message: "Open browser",
    model: "gpt-5.6-terra",
    prompt: {
      kind: "text",
      message: "Paste callback URL",
      placeholder: "http://localhost:1455/auth/callback?...",
    },
  });

  authorization.submitLoginInput(
    "http://localhost:1455/auth/callback?code=test&state=test",
  );
  await authorization.login;
  assert.equal(
    submitted,
    "http://localhost:1455/auth/callback?code=test&state=test",
  );
  assert.deepEqual(await authorization.status(), {
    state: "signed_out",
    model: "gpt-5.6-terra",
  });
  assert.equal(process.env.PI_OAUTH_CALLBACK_HOST, callbackHostBefore);
});

test("a failed DSH login remains visible after status polling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-dsh-codex-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorization = await DshCodexAuthorization.create({
    credentialPath: join(root, ".credentials.yaml"),
  });
  t.after(() => authorization.close());

  const service = authorization.ctx.authorization;
  const originalBegin = service.begin;
  service.begin = async ({ interaction }) => {
    interaction.notify({
      message: "Exchanging authorization code",
      url: "https://auth.openai.com/oauth/authorize?test=true",
    });
    throw new Error("OpenAI Codex token exchange failed (400)");
  };
  t.after(() => {
    service.begin = originalBegin;
  });

  await authorization.startLogin("browser");
  await authorization.login;
  assert.deepEqual(await authorization.status(), {
    state: "error",
    message: "已收到登录回调，但 OpenAI 令牌交换失败；请检查网络或代理后重试。",
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(await authorization.status(), {
    state: "error",
    message: "已收到登录回调，但 OpenAI 令牌交换失败；请检查网络或代理后重试。",
    model: "gpt-5.6-terra",
  });
});
