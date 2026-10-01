import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVeyaCreatorApp, VeyaCreatorService } from "../src/veya-creator-routes.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
test("creator update fingerprint, durable answer replay, and owned artifact transport reject tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-artifact-"));
  try {
    const creationRoot = join(root, "creation"), worker = join(root, "worker.json");
    await mkdir(join(creationRoot, "artifacts"), { recursive: true });
    await mkdir(join(creationRoot, "blobs"));
    await writeFile(worker, JSON.stringify({ role: "creator-worker", creation_session_id: "a".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49000/", token: "c".repeat(64), creation_root: creationRoot }));
    const blob = Buffer.from("immutable cooked bytes"), blobId = hash(blob), candidate = "b".repeat(64);
    await writeFile(join(creationRoot, "blobs", `${blobId}.bin`), blob);
    const manifest = JSON.stringify({ schema_version: 1, kind: "patch", candidate_hash: candidate,
      assets: [{ files: [{ blob_id: blobId, bytes: blob.length, path: "example.res" }] }] });
    const artifactId = hash(manifest);
    await writeFile(join(creationRoot, "artifacts", `${artifactId}.json`), manifest);
    const runId = randomUUID(); let completed = false, answers = 0, started: unknown, resultStatus = "ready";
    const flow = { async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "catalog") return { flows: [{ id: "veya/veya-wish", service: true, available: true }] } as T;
      if (method === "start") { started = params?.input; return { id: runId, status: "waiting_input" } as T; }
      if (method === "answer") { answers++; completed = true; if (answers === 1) throw new Error("accepted response lost"); return {} as T; }
      return { id: runId, status: completed ? "completed" : "waiting_input", steps: completed ? [] : [
        { kind: "checkpoint", stepKey: "main/clarify", status: "waiting_input", prompt: "layout", outputSchema: {} }],
        output: { status: resultStatus, artifact: { schema_version: 1, artifact_id: artifactId, content_hash: artifactId,
          candidate_hash: candidate, kind: "patch", verified: true } } } as T;
    } };
    const service = new VeyaCreatorService(root, flow as never);
    await service.initialize();
    const token = await service.register("player", "home", worker), app = createVeyaCreatorApp(service);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const target = { worldId: "world1", baseRevision: 7, allowedEntityIds: ["tower"], allowSpawnChange: false };
    const requestId = randomUUID(), payload = { requestId, operation: "update_layout", text: "move the tower", targetWorldId: "world1", target };
    const send = (path: string, value: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(value) });
    assert.equal((await send("/tasks", payload)).status, 202);
    assert.deepEqual(started, { operation: "update_layout", text: "move the tower", target, targetWorldId: "world1", kind: "world", homeWorldId: "home" });
    assert.equal((await send("/tasks", { ...payload, target: { ...target, baseRevision: 8 } })).status, 409);
    assert.equal((await send("/tasks", { ...payload, targetWorldId: "world2" })).status, 400);
    assert.equal((await send("/tasks", { ...payload, operation: "update_environment" })).status, 409);
    const answer = { commandId: randomUUID(), checkpointRunId: runId, stepKey: "main/clarify", answer: "east" };
    assert.equal((await send(`/tasks/${requestId}/answer`, answer)).status, 503);
    assert.equal((await send(`/tasks/${requestId}/answer`, answer)).status, 200);
    assert.equal((await send(`/tasks/${requestId}/answer`, answer)).status, 200);
    assert.equal(answers, 2, "same durable command retried after lost receipt then cached");
    const saved = JSON.parse(await readFile(join(service.directory, "bindings.json"), "utf8"));
    assert.equal(saved.bindings[requestId].answers[answer.commandId].accepted, true);
    const state = await app.request(`/tasks/${requestId}`, { headers });
    assert.equal((await state.json() as { deliveryStatus: string }).deliveryStatus, "pending_delivery");
    resultStatus = "blocked";
    assert.equal((await (await app.request(`/tasks/${requestId}`, { headers })).json() as { deliveryStatus: string }).deliveryStatus, "not_ready");
    assert.equal((await app.request(`/tasks/${requestId}/artifact`, { headers })).status, 409,
      "completed blocked result with a retained valid artifact cannot claim delivery");
    resultStatus = "ready";
    const response = await app.request(`/tasks/${requestId}/artifact`, { headers });
    assert.equal(response.status, 200); assert.equal(await response.text(), manifest);
    const content = await app.request(`/tasks/${requestId}/artifact/blobs/${blobId}`, { headers });
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), blob);
    // An opaque hash is not authority: only an owned, verified artifact in this
    // exact worker session can become a trusted predecessor for a new Run.
    const edit = { requestId: randomUUID(), operation: "update_layout", text: "move only the tower",
      previousArtifactId: artifactId, artifactTarget: { allowedEntityIds: ["tower"], allowSpawnChange: false } };
    assert.equal((await send("/tasks", { ...edit, previousArtifactId: "d".repeat(64) })).status, 409);
    assert.equal((await send("/tasks", { ...edit, targetWorldId: "world1" })).status, 400);
    assert.equal((await send("/tasks", { ...edit, operation: "create_prop" })).status, 400);
    assert.equal((await send("/tasks", edit)).status, 202);
    const linked = JSON.parse(await readFile(join(service.directory, "bindings.json"), "utf8"));
    assert.deepEqual(linked.bindings[edit.requestId].previousArtifact,
      { artifactId, candidateHash: candidate, kind: "patch" });
    assert.equal((await send("/tasks", { ...edit, artifactTarget: { ...edit.artifactTarget, allowedEntityIds: ["other"] } })).status, 409);
    const existingTarget = { ...target, baseRevision: 9, baseHash: "f".repeat(64) };
    const existing = { requestId: randomUUID(), operation: "update_layout", text: "move the saved tower only",
      previousArtifactId: artifactId, target: existingTarget };
    for (const bad of [{ ...existing, artifactTarget: edit.artifactTarget }, { ...existing, prior: {} },
      { ...existing, context: {} }, { ...existing, target: { ...existingTarget, baseHash: undefined } },
      { ...existing, target: { ...existingTarget, baseRevision: 0 } }, { ...existing, operation: "create_world" }])
      assert.equal((await send("/tasks", bad)).status, 400, "ambiguous or unguarded saved-world lineage input must fail");
    assert.equal((await send("/tasks", existing)).status, 202);
    assert.equal((await send("/tasks", existing)).status, 202);
    for (const changed of [{ ...existingTarget, baseRevision: 10 }, { ...existingTarget, baseHash: "e".repeat(64) },
      { ...existingTarget, allowedEntityIds: ["other"] }, { ...existingTarget, allowSpawnChange: true }])
      assert.equal((await send("/tasks", { ...existing, target: changed })).status, 409);
    const existingBinding = JSON.parse(await readFile(join(service.directory, "bindings.json"), "utf8")).bindings[existing.requestId];
    assert.deepEqual(existingBinding.input.target, existingTarget);
    assert.deepEqual(existingBinding.previousArtifact, { artifactId, candidateHash: candidate, kind: "patch" });
    const otherWorker = join(root, "other-worker.json");
    await writeFile(otherWorker, JSON.stringify({ role: "creator-worker", creation_session_id: "e".repeat(32),
      protocol: "veya-world-http/1", base_url: "http://127.0.0.1:49001/", token: "f".repeat(64), creation_root: creationRoot }));
    for (const player of ["player", "another_player"]) {
      const ownToken = await service.register(player, "home", otherWorker);
      const denied = await app.request("/tasks", { method: "POST", headers: { ...headers, authorization: `Bearer ${ownToken}` },
        body: JSON.stringify({ ...edit, requestId: randomUUID() }) });
      assert.equal(denied.status, 409);
      assert.deepEqual(await denied.json(), { error: "previous_artifact_unavailable" });
      const otherSaved = await app.request("/tasks", { method: "POST", headers: { ...headers, authorization: `Bearer ${ownToken}` },
        body: JSON.stringify({ ...existing, requestId: randomUUID() }) });
      assert.equal(otherSaved.status, 409);
      assert.deepEqual(await otherSaved.json(), { error: "previous_artifact_unavailable" });
      // No request binding was written, so this unused worker can be registered
      // by another identity only after dropping the transient test client.
      service.clients.delete(hash(ownToken));
    }
    // File hashes alone cannot detect a redirected section directory. Both
    // section roots must remain physical children of the bound creation root.
    const blobRoot = join(creationRoot, "blobs"), relocated = join(root, "relocated-blobs");
    await rename(blobRoot, relocated);
    await symlink(relocated, blobRoot, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await app.request(`/tasks/${requestId}/artifact/blobs/${blobId}`, { headers })).status, 409);
    await rm(blobRoot);
    await rename(relocated, blobRoot);
    await writeFile(join(creationRoot, "blobs", `${blobId}.bin`), Buffer.alloc(blob.length));
    assert.equal((await app.request(`/tasks/${requestId}/artifact/blobs/${blobId}`, { headers })).status, 409);
    await writeFile(join(creationRoot, "artifacts", `${artifactId}.json`), manifest + " ");
    assert.equal((await app.request(`/tasks/${requestId}/artifact`, { headers })).status, 409);
    assert.equal((await (await app.request(`/tasks/${requestId}`, { headers })).json() as { deliveryStatus: string }).deliveryStatus, "not_ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});
