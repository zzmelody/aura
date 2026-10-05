import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCreatorBindingDocument } from "@aura/orchestration";
import { createVeyaCreatorApp, VeyaCreatorService } from "../src/veya-creator-routes.ts";

test("three wishes bind independent workers, checkpoints and durable identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-parallel-"));
  try {
    const workers: string[] = [];
    for (const identity of ["a", "b", "c"]) {
      const path = join(root, `${identity}-worker.json`); workers.push(path);
      await writeFile(path, JSON.stringify({ role: "creator-worker", creation_session_id: identity.repeat(32),
        protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49000/", token: "d".repeat(64) }));
    }
    const runs = new Map<string, { id: string; status: string; steps: unknown[] }>();
    const requests = new Map<string, string>();
    const answers: Record<string, unknown>[] = [];
    const flow = { async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", service: true, available: true }] } as T;
      if (method === "start") {
        const key = params.requestId as string;
        let id = requests.get(key);
        if (!id) {
          id = randomUUID(); requests.set(key, id);
          runs.set(id, { id, status: "waiting_input", steps: [{ kind: "checkpoint", status: "waiting_input", stepKey: "main/clarify",
            prompt: JSON.stringify({ title: key, questions: [{ questionId: "size", kind: "text", title: "尺寸" }] }) }] });
        }
        return runs.get(id) as T;
      }
      if (method === "answer") { answers.push(params); runs.get(params.id as string)!.status = "running"; return {} as T; }
      if (method === "get") return runs.get(params.id as string) as T;
      throw new Error(`unexpected_${method}`);
    } };
    const service = new VeyaCreatorService(root, flow as never); await service.initialize();
    const app = createVeyaCreatorApp(service);
    const connect = async (target = app, bootstrap = service.bootstrapToken) => {
      const response = await target.request("/clients", { method: "POST",
        headers: { authorization: `Bearer ${bootstrap}`, "content-type": "application/json" },
        body: JSON.stringify({ playerId: "player", homeWorldId: "home", workerSessionPath: workers[0], workerSessionPaths: workers.slice(1) }) });
      assert.equal(response.status, 201);
      const registered = await response.json() as { token: string; capacity: number };
      assert.equal(registered.capacity, 3);
      return registered.token;
    };
    const token = await connect(), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const submit = (id: string) => app.request("/tasks", { method: "POST", headers, body: JSON.stringify({ requestId: id, kind: "prop", text: "斧头" }) });
    const responses = await Promise.all(ids.map(submit));
    assert.deepEqual(responses.map(response => response.status), [202, 202, 202]);
    assert.equal((await submit(randomUUID())).status, 409);
    const stored = await readCreatorBindingDocument(root, await readFile(join(service.directory, "bindings.json")));
    assert.equal(new Set(ids.map(id => stored.bindings[id]!.creationSessionId)).size, 3);
    assert.equal(new Set(ids.map(id => stored.bindings[id]!.sessionPath)).size, 3);
    assert.equal(new Set(ids.map(id => stored.bindings[id]!.runId)).size, 3);
    assert.equal((await submit(ids[1]!)).status, 202, "idempotent retry stays on its original worker even when all three are occupied");
    assert.equal(requests.size, 3);
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]!, runId = stored.bindings[id]!.runId;
      const response = await app.request(`/tasks/${id}/answer`, { method: "POST", headers,
        body: JSON.stringify({ commandId: randomUUID(), checkpointRunId: runId, stepKey: "main/clarify", answer: { size: String(index) } }) });
      assert.equal(response.status, 200);
      assert.equal(answers[index]?.id, runId);
      assert.deepEqual(answers[index]?.output, { size: String(index) });
    }
    runs.get(stored.bindings[ids[1]!]!.runId)!.status = "cancelled";
    const next = randomUUID(); assert.equal((await submit(next)).status, 202);
    const after = await readCreatorBindingDocument(root, await readFile(join(service.directory, "bindings.json")));
    assert.equal(after.bindings[next]!.creationSessionId, stored.bindings[ids[1]!]!.creationSessionId);
    const restored = new VeyaCreatorService(root, flow as never); await restored.initialize();
    const restoredApp = createVeyaCreatorApp(restored), restoredToken = await connect(restoredApp, restored.bootstrapToken);
    const duplicate = await restoredApp.request("/tasks", { method: "POST", headers: { ...headers, authorization: `Bearer ${restoredToken}` },
      body: JSON.stringify({ requestId: ids[2], kind: "prop", text: "斧头" }) });
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json() as { runId: string }).runId, stored.bindings[ids[2]!]!.runId);
    assert.equal(requests.size, 4);
    // A finished run with an unresolved lease cannot lend its worker to a new wish.
    runs.get(after.bindings[next]!.runId)!.status = "completed";
    await mkdir(service.directory, { recursive: true });
    await writeFile(join(service.directory, "playtest-leases.json"), JSON.stringify({ version: 1, leases: {
      [after.bindings[next]!.creationSessionId]: { rootRunId: after.bindings[next]!.runId, requestId: next, state: "needs_attention" },
    } }));
    assert.equal((await submit(randomUUID())).status, 409);
    await assert.rejects(service.register("other", "home", workers[1]!), /worker_already_bound/u);
    await assert.rejects(service.register("player", "home", workers[0]!, undefined, [workers[0]!]), /invalid_client/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
