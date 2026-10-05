import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVeyaCreatorApp, VeyaCreatorService } from "../src/veya-creator-routes.ts";

test("owned creator history restores wish text and exposes only fixed failure reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-history-"));
  try {
    const worker = join(root, "worker.json"), runId = randomUUID();
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "a".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49000/", token: "b".repeat(64) }));
    let status = "running", error = "", output: unknown;
    const flow = { async request<T>(method: string): Promise<T> {
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", service: true, available: true }] } as T;
      return { id: runId, status, error, output, steps: [] } as T;
    } };
    const service = new VeyaCreatorService(root, flow as never);
    await service.initialize();
    const token = await service.register("player", "home", worker), app = createVeyaCreatorApp(service);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const requestId = randomUUID(), text = "帮我做个斧头";
    assert.equal((await app.request("/tasks", { method: "POST", headers,
      body: JSON.stringify({ requestId, kind: "prop", text }) })).status, 202);
    const history = await (await app.request("/tasks", { headers })).json() as { tasks: { text: string }[] };
    assert.equal(history.tasks[0]?.text, text);
    for (const [nextStatus, nextError, expected] of [
      ["failed", "creator_worker_capabilities_unavailable", "worker_unavailable"],
      ["failed", "creator_worker_upgrade_required: private-worker-detail", "worker_upgrade_required"],
      ["failed", "model_unauthorized", "model_unauthorized"],
      ["failed", "C:/private/provider-token-and-error", "production_failed"],
      ["cancelled", "Flow 已取消。", "cancelled"],
      ["interrupted", "private interrupted detail", "interrupted"],
      ["needs_attention", "private uncertain outcome", "production_needs_attention"],
      ["running", "", ""],
    ]) {
      status = nextStatus!; error = nextError!;
      const projection = await (await app.request(`/tasks/${requestId}`, { headers })).json() as Record<string, unknown>;
      assert.equal(projection.text, text); assert.equal(projection.runStatus, status);
      assert.equal(projection.failureReason, expected);
      assert.equal(Object.hasOwn(projection, "error"), false);
      assert.equal(JSON.stringify(projection).includes("private"), false);
      if (status === "needs_attention") {
        assert.equal(projection.phase, "needs_attention");
        assert.equal(projection.deliveryStatus, "not_ready");
      }
    }
    status = "completed"; output = { status: "blocked", issues: [{ detail: "private specification diagnostic" }] };
    const blocked = await (await app.request(`/tasks/${requestId}`, { headers })).json() as Record<string, unknown>;
    assert.equal(blocked.runStatus, "failed"); assert.equal(blocked.failureReason, "production_failed");
    assert.equal(blocked.deliveryStatus, "not_ready"); assert.equal(JSON.stringify(blocked).includes("private"), false);
    output = { status: "ready" };
    const unverified = await (await app.request(`/tasks/${requestId}`, { headers })).json() as Record<string, unknown>;
    assert.equal(unverified.failureReason, "delivery_unverified"); assert.equal(unverified.deliveryStatus, "not_ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});
