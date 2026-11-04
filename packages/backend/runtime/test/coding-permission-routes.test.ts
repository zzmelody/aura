import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowError, type OrchestrationHost } from "@aura/orchestration";
import { CODING_PERMISSIONS } from "@aura/protocol";
import type { CodingPermission } from "@aura/protocol/types";
import { createCodingApp } from "../src/coding-routes.ts";

test("the permission route forwards only a supported preset for the named session", async () => {
  const calls: Array<[string, CodingPermission]> = [];
  const app = createCodingApp({
    selectConversationPermission: async (
      id: string,
      permission: CodingPermission,
    ) => {
      calls.push([id, permission]);
      if (id === "closed") throw new FlowError("对话不存在或已归档。", 404);
      return { updated: true };
    },
  } as unknown as OrchestrationHost);
  const select = (id: string, body: string) =>
    app.request(`/sessions/${id}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  for (const body of [
    "{",
    "null",
    "{}",
    '{"permission":5}',
    '{"permission":"auto"}',
    '{"permission":"read-only","approval":"never"}',
  ]) {
    assert.equal((await select("side-fixture", body)).status, 400, body);
  }
  assert.deepEqual(calls, []);
  for (const permission of CODING_PERMISSIONS) {
    const response = await select(
      "side-fixture",
      JSON.stringify({ permission }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { updated: true });
  }
  assert.deepEqual(
    calls,
    CODING_PERMISSIONS.map((permission) => ["side-fixture", permission]),
  );
  assert.equal(
    (await select("closed", '{"permission":"read-only"}')).status,
    404,
  );
});
