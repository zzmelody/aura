import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { handleFlowRequest } from "../src/index.ts";
import { FlowError } from "../src/schema.ts";

test("HTTP boundary delegates flow operations, bounds bodies and hides internal errors", async (t) => {
  const calls = [];
  const host = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (params?.id === "missing")
        throw new FlowError("流程运行不存在。", 404);
      if (params?.id === "private") throw new Error("secret provider value");
      return { method, params };
    },
  };
  const server = createServer((req, res) => {
    void handleFlowRequest(host, req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  const catalog = await fetch(`${url}/flows/catalog`);
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.equal((await catalog.json()).method, "catalog");
  const started = await fetch(`${url}/flows/runs`, {
    method: "POST",
    body: JSON.stringify({ requestId: "test" }),
  });
  assert.equal(started.status, 202);
  assert.deepEqual((await started.json()).params, { requestId: "test" });
  const history = await fetch(
    `${url}/flows/runs/run-id/steps/research/history?beforeSeq=10`,
  );
  assert.deepEqual((await history.json()).params, {
    id: "run-id",
    stepId: "research",
    beforeSeq: 10,
  });
  assert.equal((await fetch(`${url}/flows/runs/missing`)).status, 404);
  const error = await fetch(`${url}/flows/runs/private`);
  assert.equal(error.status, 500);
  assert.doesNotMatch(await error.text(), /secret/);
  const count = calls.length;
  for (const body of ["no json", "null", "[]", '"scalar"']) {
    assert.equal(
      (await fetch(`${url}/flows/runs`, { method: "POST", body })).status,
      400,
    );
  }
  assert.equal(
    (
      await fetch(`${url}/flows/runs`, {
        method: "POST",
        body: "x".repeat(270000),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(`${url}/flows/arbitrary-rpc`, { method: "POST" })).status,
    404,
  );
  assert.equal((await fetch(`${url}/elsewhere`)).status, 404);
  assert.equal(calls.length, count, "invalid routes/bodies must not reach DSH");
});
