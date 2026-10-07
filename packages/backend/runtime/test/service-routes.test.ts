import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { createServiceApp, failureCode, ServiceRuns, type ServiceFlowPort } from "../src/service-routes.ts";

const TOKEN = "a".repeat(64);
const hash = "b".repeat(64);

function run(id: string, flowId: string, extra: Partial<FlowRun> = {}): FlowRun {
  return {
    id, requestId: randomUUID(), flow: { id: flowId, title: flowId, description: "", sourceHash: hash },
    input: {}, mode: "codex", status: "running", createdAt: 0, steps: [], ...extra,
  };
}

function fixture() {
  const runs = new Map<string, FlowRun>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const port: ServiceFlowPort = {
    async request<T>(method: string, params: object = {}) {
      calls.push({ method, params: params as Record<string, unknown> });
      const p = params as Record<string, unknown>;
      if (method === "catalog")
        return { flows: [
          { id: "veya/veya-wish", title: "", description: "", available: true, service: true },
          { id: "veya/internal", title: "", description: "", available: true, service: false },
        ], actions: [], plugins: [], presets: [] } as T;
      if (method === "services/start") {
        if (p.flowId === "veya/veya-wish" && (p.input as Record<string, unknown>)?.text === "refuse")
          throw Object.assign(new Error("worker_busy"), { status: 422 });
        if (p.flowId === "veya/veya-wish" && (p.input as Record<string, unknown>)?.text === "leak")
          throw Object.assign(new Error("C:\\secret path"), { status: 422 });
        const created = run(randomUUID(), String(p.flowId), { requestId: String(p.requestId), status: "queued" });
        runs.set(created.id, created);
        return created as T;
      }
      if (method === "services/find") {
        const found = [...runs.values()].find((item) => item.requestId === p.requestId && !item.parent);
        if (!found) throw Object.assign(new Error("Flow 运行不存在。"), { status: 404 });
        return found as T;
      }
      if (method === "services/view")
        return (runs.get(String(p.id))?.status === "completed" ? { delivery: "pending" } : null) as T;
      if (method === "get") {
        const found = runs.get(String(p.id));
        if (!found) throw Object.assign(new Error("Flow 运行不存在。"), { status: 404 });
        return found as T;
      }
      return { ok: true } as T;
    },
  };
  const app = createServiceApp(new ServiceRuns(port, TOKEN));
  const send = (path: string, body?: unknown, token = TOKEN) => app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { runs, calls, send };
}

test("service runs require the bearer token", async () => {
  const { send } = fixture();
  assert.equal((await send("/flows", undefined, "c".repeat(64))).status, 401);
  assert.equal((await send("/flows", undefined, "")).status, 401);
  assert.deepEqual(await (await send("/flows")).json(), { flows: [{ id: "veya/veya-wish", available: true }] });
});

test("start forwards a service-only, configured-model request and returns a path-free view", async () => {
  const { send, calls } = fixture();
  const requestId = randomUUID();
  const started = await send("/runs", { requestId, flowId: "veya/veya-wish", input: { text: "lamp" } });
  assert.equal(started.status, 202);
  const view = await started.json() as Record<string, unknown>;
  assert.equal(view.flowId, "veya/veya-wish");
  assert.equal(view.requestId, requestId);
  assert.equal(view.status, "queued");
  assert.deepEqual(calls.find((c) => c.method === "services/start")?.params, {
    requestId, flowId: "veya/veya-wish", input: { text: "lamp" },
  });
  assert.equal((await send("/runs", { requestId: "nope", flowId: "veya/veya-wish", input: {} })).status, 400);
  assert.equal((await send("/runs", { requestId, flowId: "veya/veya-wish", input: {}, extra: 1 })).status, 400);
});

test("admission refusals surface only a bounded code", async () => {
  const { send } = fixture();
  const refused = await send("/runs", { requestId: randomUUID(), flowId: "veya/veya-wish", input: { text: "refuse" } });
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { code: "worker_busy" });
  const leaked = await send("/runs", { requestId: randomUUID(), flowId: "veya/veya-wish", input: { text: "leak" } });
  assert.equal(leaked.status, 422);
  assert.deepEqual(await leaked.json(), { code: "invalid_request" });
});

test("only root Runs of published service Flows are visible", async () => {
  const { send, runs } = fixture();
  const internal = run(randomUUID(), "veya/internal");
  const child = run(randomUUID(), "veya/veya-wish", { parent: { runId: randomUUID(), stepKey: "plugin/a" } });
  runs.set(internal.id, internal);
  runs.set(child.id, child);
  assert.equal((await send(`/runs/${internal.id}`)).status, 404);
  assert.equal((await send(`/runs/${child.id}`)).status, 404);
  assert.equal((await send(`/runs/${randomUUID()}`)).status, 404);
  assert.equal((await send("/runs/not-a-uuid")).status, 404);
});

test("the view exposes report, output, sanitized failure code and the deepest waiting checkpoint", async () => {
  const { send, runs, calls } = fixture();
  const grandchild = run(randomUUID(), "veya/inner", { status: "waiting_input", steps: [
    { kind: "checkpoint", id: "pick", label: "pick", status: "waiting_input", stepKey: "plugin/main/pick",
      prompt: "Pick one", outputSchema: { type: "string" } } as FlowRun["steps"][number],
  ] });
  const root = run(randomUUID(), "veya/veya-wish", { status: "waiting_input", report: { stage: "visual" }, steps: [
    { kind: "flow", id: "inner", label: "inner", status: "waiting_input", stepKey: "plugin/main/inner",
      flowId: "veya/inner", sourceHash: hash, input: {}, outputSchema: {}, childRequestId: randomUUID(),
      childRunId: grandchild.id, requestInputHash: hash } as FlowRun["steps"][number],
  ] });
  runs.set(root.id, root);
  runs.set(grandchild.id, grandchild);
  const view = await (await send(`/runs/${root.id}`)).json() as Record<string, unknown>;
  assert.deepEqual(view.report, { stage: "visual" });
  assert.deepEqual(view.checkpoint, { runId: grandchild.id, stepKey: "plugin/main/pick", prompt: "Pick one", schema: { type: "string" } });
  assert.equal(view.output, undefined);

  const commandId = randomUUID();
  assert.equal((await send(`/runs/${root.id}/answer`, { commandId, checkpointRunId: root.id, stepKey: "plugin/main/pick", answer: "a" })).status, 409);
  assert.equal((await send(`/runs/${root.id}/answer`, { commandId, checkpointRunId: grandchild.id, stepKey: "plugin/main/pick", answer: "a" })).status, 200);
  assert.deepEqual(calls.find((c) => c.method === "answer")?.params,
    { id: grandchild.id, stepKey: "plugin/main/pick", requestId: commandId, output: "a" });

  const failed = run(randomUUID(), "veya/veya-wish", { status: "failed", error: "ActionFailure: worker_busy: all workers are busy at C:\\secret" });
  runs.set(failed.id, failed);
  assert.deepEqual((await (await send(`/runs/${failed.id}`)).json() as Record<string, unknown>).error, { code: "worker_busy" });

  const done = run(randomUUID(), "veya/veya-wish", { status: "completed", output: { artifactId: hash } });
  runs.set(done.id, done);
  const doneView = await (await send(`/runs/${done.id}`)).json() as Record<string, unknown>;
  assert.deepEqual(doneView.output, { artifactId: hash });
  assert.deepEqual(doneView.view, { delivery: "pending" });
  assert.equal(view.view, undefined);
});

test("a client addresses its Run by its own requestId, and commands reach the resolved root Run", async () => {
  const { send, runs, calls } = fixture();
  const root = run(randomUUID(), "veya/veya-wish");
  runs.set(root.id, root);
  const view = await (await send(`/runs/${root.requestId}`)).json() as Record<string, unknown>;
  assert.equal(view.runId, root.id);
  const commandId = randomUUID();
  assert.equal((await send(`/runs/${root.requestId}/cancel`, { commandId })).status, 200);
  assert.deepEqual(calls.filter((c) => c.method === "cancel").at(-1)?.params, { id: root.id, requestId: commandId });
});

test("cancel and resume forward the command id to the root Run", async () => {
  const { send, runs, calls } = fixture();
  const root = run(randomUUID(), "veya/veya-wish");
  runs.set(root.id, root);
  for (const operation of ["cancel", "resume"]) {
    const commandId = randomUUID();
    assert.equal((await send(`/runs/${root.id}/${operation}`, { commandId })).status, 200);
    assert.deepEqual(calls.filter((c) => c.method === operation).at(-1)?.params, { id: root.id, requestId: commandId });
  }
  assert.equal((await send(`/runs/${root.id}/cancel`, {})).status, 400);
  const commandId = randomUUID();
  assert.equal((await send(`/runs/${root.id}/resume`, { commandId, input: { orderId: "o1" } })).status, 200);
  assert.deepEqual(calls.filter((c) => c.method === "services/resume").at(-1)?.params,
    { id: root.id, requestId: commandId, input: { orderId: "o1" } });
});

test("failure codes never leak free text", () => {
  assert.equal(failureCode({ status: "failed", error: "Flow 步骤失败。" }), "failed");
  assert.equal(failureCode({ status: "failed", error: "creator_production_recovery_unavailable" }), "creator_production_recovery_unavailable");
  assert.equal(failureCode({ status: "interrupted", error: "revision_mismatch: x" }), "interrupted");
  assert.equal(failureCode({ status: "completed" }), undefined);
});
