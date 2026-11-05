import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowError, type OrchestrationHost } from "../src/dsh/host.ts";
import { createCodingApp } from "../src/coding-routes.ts";

test("assistant restoration is read-only and explicit opening forwards creation intent", async () => {
  const calls: boolean[] = [];
  const app = createCodingApp({
    personalAssistant: async (create: boolean) => {
      calls.push(create);
      return null;
    },
  } as unknown as OrchestrationHost);
  assert.equal((await app.request("/assistant")).status, 200);
  assert.equal(await (await app.request("/assistant")).json(), null);
  assert.equal(
    (await app.request("/assistant", { method: "POST" })).status,
    200,
  );
  assert.deepEqual(calls, [false, false, true]);
});

test("assistant service errors retain their HTTP status and actionable message", async () => {
  const app = createCodingApp({
    personalAssistant: async () => {
      throw new FlowError("助手工作空间暂不可用。", 409);
    },
  } as unknown as OrchestrationHost);
  const response = await app.request("/assistant", { method: "POST" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    message: "助手工作空间暂不可用。",
  });
});
