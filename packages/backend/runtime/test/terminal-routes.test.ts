import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationHost } from "@aura/orchestration";
import { FlowError } from "@aura/orchestration";
import { createTerminalApp } from "../src/terminal-routes.ts";
import { Hono } from "hono";
import { localOriginPolicy } from "../src/http-server.ts";

test("same-host clients can close tools and reconnect SSE across runtime ports", async () => {
  const app = new Hono();
  app.use("*", localOriginPolicy);
  app.delete("/coding/terminals/terminal-one", (context) =>
    context.json({ closed: true }),
  );
  const response = await app.request(
    "http://127.0.0.1:4311/coding/terminals/terminal-one",
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:8081",
        Host: "127.0.0.1:4311",
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "Last-Event-ID",
      },
    },
  );
  assert.equal(response.status, 204);
  assert.ok(
    response.headers.get("Access-Control-Allow-Methods")?.includes("DELETE"),
  );
  assert.ok(
    response.headers
      .get("Access-Control-Allow-Headers")
      ?.toLowerCase()
      .includes("last-event-id"),
  );
});

test("terminal routes forward only workspace and terminal operations with bounded DTOs", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: Pick<OrchestrationHost, "request"> = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      // This is a synthetic RPC responder, not external JSON.
      return { closed: true } as T;
    },
  };
  const app = createTerminalApp(host);
  const created = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "space",
      cwd: "unregistered",
      env: { SECRET: "do-not-forward" },
    }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(calls[0], {
    method: "coding/terminals/open",
    params: { projectId: "space", cols: 80, rows: 24 },
  });
  await app.request("/terminal-one?force=true", { method: "DELETE" });
  assert.deepEqual(calls[1], {
    method: "coding/terminals/close",
    params: { terminalId: "terminal-one", force: true },
  });
  const malformed = await app.request("/", {
    method: "POST",
    body: "not JSON",
  });
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 2);
});

test("busy terminal closure returns a reviewable conflict and unknown failures stay sanitized", async () => {
  const host: Pick<OrchestrationHost, "request"> = {
    async request<T>(method: string): Promise<T> {
      if (method.endsWith("close"))
        throw new FlowError("终端可能仍有任务运行。", 409);
      throw new Error("private provider details");
    },
  };
  const app = createTerminalApp(host);
  const busy = await app.request("/terminal-one", { method: "DELETE" });
  assert.equal(busy.status, 409);
  const failed = await app.request("/?projectId=space");
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes("private provider details"));
  assert.equal(
    (await app.request("/terminal-one/events?cursor=-1")).status,
    400,
  );
});
