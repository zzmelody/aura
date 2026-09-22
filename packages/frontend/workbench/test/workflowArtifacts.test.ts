import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowArtifact } from "@aura/protocol/types";
import { artifactUrl, visibleArtifacts } from "../src/workflowArtifacts.ts";
const artifact: WorkflowArtifact = {
  id: "reference",
  artifactId: "content",
  runId: "child",
  stepKey: "agent",
  attempt: 2,
  callId: "call",
  name: "model.glb",
  kind: "model",
  format: "glb",
  mimeType: "model/gltf-binary",
  bytes: 24,
  status: "ready",
};

test("preview URLs use the saved runtime endpoint, encode identifiers and never use a file path", () => {
  assert.equal(
    artifactUrl("http://192.168.1.20:4311/", "run/id", "sha"),
    "http://192.168.1.20:4311/flows/runs/run%2Fid/artifacts/sha/content",
  );
  assert.equal(
    artifactUrl("http://localhost:4311", "run", "sha", "content", true),
    "http://localhost:4311/flows/runs/run/artifacts/sha/content?download=1",
  );
});
test("run gallery deduplicates content while step galleries preserve nested run and attempt identity", () => {
  const items = [
    artifact,
    { ...artifact, id: "second", runId: "parent", attempt: 1 },
  ];
  assert.equal(visibleArtifacts(items).length, 1);
  assert.deepEqual(
    visibleArtifacts(items, { runId: "child", stepKey: "agent", attempt: 2 }),
    [artifact],
  );
  assert.equal(
    visibleArtifacts(items, { runId: "child", stepKey: "agent", attempt: 1 })
      .length,
    0,
  );
});
