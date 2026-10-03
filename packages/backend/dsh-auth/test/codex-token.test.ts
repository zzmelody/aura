import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { codexAccountId, codexTokenSource, readCodexGrant } from "../src/codex-token.ts";

/** Unsigned JWT-shaped token carrying only the claim the source reads. */
const token = (accountId: string) =>
  `h.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url")}.s`;

function fakeContext(initial: { access: string; expires: number } | undefined) {
  let grant = initial;
  const calls: unknown[] = [];
  const ctx = {
    get(name: string) {
      if (name !== "credentials") return undefined;
      return {
        async readRecord() {
          return grant ? { kind: "grant", payload: { type: "oauth", refresh: "r", ...grant } } : undefined;
        },
        async describeRecord() {
          return { configured: grant !== undefined };
        },
      };
    },
    llm: {
      async *stream(options: unknown) {
        calls.push(options);
        // The DSH adapter refreshes and persists the grant during the call.
        grant = { access: token("acct-2"), expires: Date.now() + 3_600_000 };
        yield { type: "text-delta", index: 0, text: "ok" };
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

test("grant parsing and account claim reading reject anything malformed", () => {
  assert.deepEqual(readCodexGrant({ kind: "grant", payload: { access: "a", expires: 5 } }), {
    access: "a",
    expires: 5,
  });
  assert.equal(readCodexGrant({ kind: "api-key", key: "k" }), undefined);
  assert.equal(readCodexGrant({ kind: "grant", payload: { access: 1 } }), undefined);
  assert.equal(readCodexGrant(undefined), undefined);
  assert.equal(codexAccountId(token("acct-1")), "acct-1");
  assert.equal(codexAccountId("not-a-jwt"), undefined);
});

test("a fresh stored token is returned without any model call", async () => {
  const { ctx, calls } = fakeContext({ access: token("acct-1"), expires: Date.now() + 86_400_000 });
  const source = codexTokenSource(ctx, "gpt-test");
  assert.equal(await source.signedIn(), true);
  assert.deepEqual(await source.token(), { token: token("acct-1"), accountId: "acct-1" });
  assert.equal(calls.length, 0);
});

test("a near-expiry token is refreshed once through DSH, then reread", async () => {
  const { ctx, calls } = fakeContext({ access: token("acct-1"), expires: Date.now() + 60_000 });
  const source = codexTokenSource(ctx, "gpt-test");
  const [a, b] = await Promise.all([source.token(), source.token()]);
  assert.equal(a?.accountId, "acct-2");
  assert.equal(b?.accountId, "acct-2");
  assert.equal(calls.length, 1);
  const call = calls[0] as { provider: string; model: string; maxTokens: number };
  assert.equal(call.provider, "openai-codex");
  assert.equal(call.model, "gpt-test");
  assert.equal(call.maxTokens, 16);
});

test("signed out returns no token and makes no model call", async () => {
  const { ctx, calls } = fakeContext(undefined);
  const source = codexTokenSource(ctx, "gpt-test");
  assert.equal(await source.signedIn(), false);
  assert.equal(await source.token(), undefined);
  assert.equal(calls.length, 0);
});
