import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVeyaCreatorApp, VeyaCreatorService } from "../src/veya-creator-routes.ts";
import { readCreatorBindingDocument } from "@aura/orchestration";

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
      ["failed", "model_budget_exceeded: private provider budget", "model_budget_exceeded"],
      ["needs_attention", "model_budget_exceeded: private provider budget", "model_budget_exceeded"],
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

test("history deletion is owned, terminal-only, durable and preserves run provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-history-delete-"));
  try {
    const worker = join(root, "worker.json"), runId = randomUUID(), requestId = randomUUID();
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "a".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49000/", token: "b".repeat(64) }));
    let status = "running";
    const methods: string[] = [];
    const flow = { async request<T>(method: string): Promise<T> {
      methods.push(method);
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", service: true, available: true }] } as T;
      return { id: runId, status, steps: [] } as T;
    } };
    const service = new VeyaCreatorService(root, flow as never);
    await service.initialize();
    const token = await service.register("player", "home", worker), app = createVeyaCreatorApp(service);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const otherWorker = join(root, "other-worker.json"), otherHomeWorker = join(root, "other-home-worker.json");
    for (const [path, identity] of [[otherWorker, "c"], [otherHomeWorker, "d"]])
      await writeFile(path!, JSON.stringify({ role: "creator-worker", creation_session_id: identity!.repeat(32),
        protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49000/", token: "b".repeat(64) }));
    const otherToken = await service.register("other", "home", otherWorker);
    const otherHomeToken = await service.register("player", "other_home", otherHomeWorker);
    const url = `/tasks/${requestId}/delete-record`, body = JSON.stringify({ commandId: randomUUID() });
    const history = async () => (await (await app.request("/tasks", { headers })).json() as { tasks: unknown[] }).tasks;
    assert.equal((await app.request("/tasks", { method: "POST", headers,
      body: JSON.stringify({ requestId, kind: "prop", text: "斧头" }) })).status, 202);
    assert.equal((await app.request(url, { method: "POST", body })).status, 401);
    for (const bearer of [otherToken, otherHomeToken]) {
      assert.equal((await app.request(url, { method: "POST", body,
        headers: { ...headers, authorization: `Bearer ${bearer}` } })).status, 404);
    }
    assert.equal((await app.request(url, { method: "POST", headers, body: "{}" })).status, 400);
    for (const next of ["queued", "running", "waiting_input", "needs_attention"]) {
      status = next;
      const response = await app.request(url, { method: "POST", headers, body });
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: string }).error, "task_active");
      assert.equal((await history()).length, 1);
    }
    // No commit or cancellation happens on a failed status read.
    const failedRead = new VeyaCreatorService(root, { request: async () => { throw new Error("private"); } } as never);
    await failedRead.initialize();
    const failedToken = await failedRead.register("player", "home", worker);
    assert.equal((await createVeyaCreatorApp(failedRead).request(url, { method: "POST", body,
      headers: { ...headers, authorization: `Bearer ${failedToken}` } })).status, 503);
    assert.equal((await history()).length, 1);
    status = "cancelled";
    assert.equal((await app.request(url, { method: "POST", headers, body })).status, 200);
    assert.equal((await history()).length, 0);
    const count = methods.length;
    assert.equal((await app.request(url, { method: "POST", headers, body })).status, 200);
    assert.equal(methods.length, count, "repeat deletion does not contact the run again");
    const stored = await readCreatorBindingDocument(root, await readFile(join(service.directory, "bindings.json")));
    assert.equal(stored.bindings[requestId]?.historyDeleted, true);
    assert.equal(stored.bindings[requestId]?.runId, runId);
    assert.equal(stored.bindings[requestId]?.input.text, "斧头");
    assert.equal(methods.includes("cancel") || methods.includes("delete"), false);
    for (const terminal of ["completed", "failed", "interrupted"]) {
      status = terminal;
      const nextId = randomUUID();
      assert.equal((await app.request("/tasks", { method: "POST", headers,
        body: JSON.stringify({ requestId: nextId, kind: "prop", text: "另一个物品" }) })).status, 202);
      assert.equal((await app.request(`/tasks/${nextId}/delete-record`, { method: "POST", headers, body })).status, 200);
      assert.equal((await history()).length, 0);
    }
    const restored = new VeyaCreatorService(root, flow as never); await restored.initialize();
    const restoredToken = await restored.register("player", "home", worker);
    assert.deepEqual(restored.list(restored.client(`Bearer ${restoredToken}`)!), []);
    assert.equal((await restored.project(restored.owned(restored.client(`Bearer ${restoredToken}`)!, requestId)!)).historyDeleted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
