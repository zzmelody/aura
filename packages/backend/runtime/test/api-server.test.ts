import assert from "node:assert/strict";
import test from "node:test";
import { createApiApp } from "../src/api-server.ts";
import type { CodexAuthPort, DshSessionPort } from "../src/types.ts";

const codexAuth: CodexAuthPort = {
  modelId: "gpt-test",
  async status() {
    return { state: "signed_out", model: this.modelId };
  },
  async startLogin(method) {
    return { state: "pending", method, model: this.modelId };
  },
  submitLoginInput() {
    return { state: "signed_out", model: this.modelId };
  },
  async cancelLogin() {
    return { state: "signed_out", model: this.modelId };
  },
};

const dsh: DshSessionPort = {
  async stream(_messages, emit, route) {
    emit({ type: "delta", text: "hello" });
    emit(
      route.mode === "codex-subscription"
        ? {
            type: "done",
            engine: "deepseek-harness",
            mode: route.mode,
            model: route.model,
          }
        : { type: "done", engine: "deepseek-harness", mode: route.mode },
    );
  },
};

test("Hono API serves health, enforces origin policy and streams NDJSON", async () => {
  const app = createApiApp({ codexAuth, dsh });

  const health = await app.request("/health");
  assert.equal(health.status, 200);
  assert.equal(
    ((await health.json()) as { service: string }).service,
    "aura-runtime",
  );

  const rejected = await app.request("/health", {
    headers: { Host: "localhost:4311", Origin: "https://example.com" },
  });
  assert.equal(rejected.status, 403);

  const capacitor = await app.request("/health", {
    headers: { Host: "192.168.1.8:4311", Origin: "https://localhost" },
  });
  assert.equal(capacitor.status, 200);
  assert.equal(
    capacitor.headers.get("access-control-allow-origin"),
    "https://localhost",
  );

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:4311",
      Origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({
      sessionId: "session-1",
      messages: [{ role: "user", text: "hello" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /x-ndjson/);
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  assert.deepEqual(
    events.map((event) => event.type),
    ["delta", "done"],
  );
});
