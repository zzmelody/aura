import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { localOriginPolicy } from "../src/http-server.ts";

test("local origin policy admits Flow service idempotency headers", async () => {
  const app = new Hono();
  app.use("*", localOriginPolicy);
  app.post("/flows/example/invoke", (context) => context.json({ ok: true }));

  const preflight = await app.request("/flows/example/invoke", {
    method: "OPTIONS",
    headers: {
      Host: "127.0.0.1:4311",
      Origin: "http://localhost:8081",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,idempotency-key",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /Idempotency-Key/i,
  );

  const foreign = await app.request("/flows/example/invoke", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:4311",
      Origin: "https://example.com",
    },
  });
  assert.equal(foreign.status, 403);
});
