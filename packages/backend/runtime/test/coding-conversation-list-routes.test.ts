import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestrationHost } from "../src/dsh/host.ts";
import { createCodingApp } from "../src/coding-routes.ts";

test("conversation lists keep full status by default and allow a metadata-only boot read", async () => {
  const calls: unknown[] = [];
  const app = createCodingApp({
    conversations: async (...args: unknown[]) => {
      calls.push(args);
      return [];
    },
  } as unknown as OrchestrationHost);
  for (const query of ["", "?status=metadata", "?status=full"])
    assert.equal(
      (await app.request(`/projects/workspace/conversations${query}`)).status,
      200,
    );
  assert.deepEqual(calls, [
    ["workspace", true],
    ["workspace", false],
    ["workspace", true],
  ]);
});

test("conversation list options reject invalid status modes before calling the backend", async () => {
  let calls = 0;
  const app = createCodingApp({
    conversations: async () => {
      calls++;
      return [];
    },
  } as unknown as OrchestrationHost);
  assert.equal(
    (await app.request("/projects/workspace/conversations?status=anything"))
      .status,
    400,
  );
  assert.equal(calls, 0);
});
