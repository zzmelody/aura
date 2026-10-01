import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { createVeyaCreatorApp, VeyaCreatorService } from "../src/veya-creator-routes.ts";

const json = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("creator requests bind a worker before starting and isolate two clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-"));
  const worker = join(root, "worker.json");
  const secondWorker = join(root, "second-worker.json");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runId = randomUUID();
  const checkpointRunId = randomUUID();
  const stepKey = "main/clarify";
  let wishAvailable = true;
  let originalStatus = "waiting_input";
  try {
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "a".repeat(32), protocol: "veya-world-http/1",
      base_url: "http://127.0.0.1:49200/", token: "a".repeat(64) }));
    await writeFile(secondWorker, JSON.stringify({ role: "creator-worker", creation_session_id: "b".repeat(32), protocol: "veya-world-http/1",
      base_url: "http://127.0.0.1:49201/", token: "c".repeat(64) }));
    let service!: VeyaCreatorService;
    const flow = { async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      requests.push({ method, params });
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", available: wishAvailable, service: true }] } as T;
      if (method === "start") {
        const saved = JSON.parse(await readFile(join(service.directory, "bindings.json"), "utf8")) as
          { bindings: Record<string, { sessionPath: string }> };
        assert.equal(saved.bindings[params.requestId as string]?.sessionPath, resolve(worker));
        return { id: runId, status: "waiting_input" } as T;
      }
      if (method === "get" && params.id === runId)
        return { id: runId, status: originalStatus, steps: [{ kind: "flow", status: "waiting_input", childRunId: checkpointRunId }] } as T;
      if (method === "get" && params.id === checkpointRunId)
        return { id: checkpointRunId, status: "waiting_input", steps: [{ kind: "checkpoint", status: "waiting_input",
          stepKey, prompt: "选择天气", outputSchema: { type: "string" } }] } as T;
      return { id: runId, status: "running", steps: [] } as T;
    } };
    service = new VeyaCreatorService(root, flow as unknown as ConstructorParameters<typeof VeyaCreatorService>[1], "b".repeat(64));
    await service.initialize();
    const app = createVeyaCreatorApp(service);
    const connect = async (playerId: string, workerPath: string) => {
      const response = await app.request("/clients", { ...json({ playerId, homeWorldId: `home_${playerId}`,
        workerSessionPath: workerPath }), headers: { ...json({}).headers, ...auth(service.bootstrapToken) } });
      assert.equal(response.status, 201);
      return (await response.json() as { token: string }).token;
    };
    const first = await connect("player_one", worker), second = await connect("player_two", secondWorker);
    assert.deepEqual(await (await app.request("/status", { headers: auth(first) })).json(),
      { connected: true, wishFlowAvailable: true });
    assert.equal((await app.request("/clients", { ...json({ playerId: "player_two",
      homeWorldId: "home_player_two", workerSessionPath: worker }),
      headers: { ...json({}).headers, ...auth(service.bootstrapToken) } })).status, 400);
    const requestId = randomUUID();
    const create = async (text: string, token = first) => app.request("/tasks", {
      ...json({ requestId, kind: "prop", text }),
      headers: { ...json({}).headers, ...auth(token) },
    });
    assert.equal((await create("一盏会开关的黄铜灯")).status, 202);
    assert.equal((await create("一盏会开关的黄铜灯")).status, 202);
    assert.equal((await create("另一件物品")).status, 409);
    assert.equal((await create("一盏会开关的黄铜灯", second)).status, 409);
    assert.equal(requests.filter((item) => item.method === "start").length, 2);
    const busy = await app.request("/tasks", { ...json({ requestId: randomUUID(), kind: "prop", text: "second simultaneous object" }),
      headers: { ...json({}).headers, ...auth(first) } });
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: "worker_busy" });
    const denied = await app.request(`/tasks/${requestId}`, { headers: auth(second) });
    assert.equal(denied.status, 404);
    const state = await app.request(`/tasks/${requestId}`, { headers: auth(first) });
    assert.equal(state.status, 200);
    assert.deepEqual((await state.json() as { checkpoint: unknown }).checkpoint,
      { runId: checkpointRunId, stepKey, prompt: "选择天气", schema: { type: "string" } });
    const answer = await app.request(`/tasks/${requestId}/answer`, {
      ...json({ commandId: randomUUID(), checkpointRunId, stepKey, answer: "晴天" }),
      headers: { ...json({}).headers, ...auth(first) },
    });
    assert.equal(answer.status, 200);
    assert.equal(requests.at(-1)?.method, "answer");
    assert.equal((await app.request(`/tasks/${requestId}/answer`, {
      ...json({ commandId: randomUUID(), checkpointRunId: randomUUID(), stepKey, answer: "雨天" }),
      headers: { ...json({}).headers, ...auth(first) },
    })).status, 409);
    wishAvailable = false;
    const unavailableId = randomUUID();
    assert.equal((await app.request("/tasks", { ...json({ requestId: unavailableId, kind: "prop",
      text: "一个新机关" }), headers: { ...json({}).headers, ...auth(first) } })).status, 503);
    const persisted = JSON.parse(await readFile(join(service.directory, "bindings.json"), "utf8")) as
      { bindings: Record<string, unknown> };
    assert.equal(unavailableId in persisted.bindings, false);
    // A terminal revision rejection has no running work to reserve the worker.
    // Unknown paid work remains guarded separately by the shared paid journal.
    wishAvailable = true;
    originalStatus = "interrupted";
    assert.equal((await app.request("/tasks", { ...json({ requestId: randomUUID(), kind: "prop",
      text: "retry after terminal revision rejection" }), headers: { ...json({}).headers, ...auth(first) } })).status, 202);
    const descriptor = JSON.parse(await readFile(worker, "utf8"));
    await writeFile(join(service.directory, "playtest-leases.json"), JSON.stringify({ version: 1, leases: {
      [descriptor.creation_session_id]: { rootRunId: runId, requestId, state: "needs_attention", cancelling: true },
    } }));
    const held = await app.request("/tasks", { ...json({ requestId: randomUUID(), kind: "prop", text: "after uncertain cleanup" }),
      headers: { ...json({}).headers, ...auth(first) } });
    assert.equal(held.status, 409, "a terminal Run with an unresolved native lease still occupies the worker");
    const heldState = await (await app.request(`/tasks/${requestId}`, { headers: auth(first) })).json() as { cleanup: string; phase: string };
    assert.equal(heldState.cleanup, "needs_attention"); assert.equal(heldState.phase, "needs_attention");
  } finally {
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
    await rm(root, { recursive: true, force: true });
  }
});
