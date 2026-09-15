import assert from "node:assert/strict";
import test from "node:test";
import { createFlowApp, type OrchestrationHost } from "../src/index.ts";
import { FlowError } from "../src/schema.ts";

test("Hono boundary delegates flow operations, bounds bodies and hides internal errors", async () => {
  const calls: Array<{ method: string; params: object }> = [];
  const host: Pick<OrchestrationHost, "request"> = {
    async request<T>(method: string, params: object = {}): Promise<T> {
      calls.push({ method, params });
      if ("id" in params && params.id === "missing")
        throw new FlowError("流程运行不存在。", 404);
      if ("id" in params && params.id === "private")
        throw new Error("secret provider value");
      if (method === "start") return { id: "started-run" } as T;
      return { method, params } as T;
    },
  };
  const app = createFlowApp(host);

  const catalog = await app.request("/catalog");
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.equal(
    ((await catalog.json()) as { method: string }).method,
    "catalog",
  );

  const started = await app.request("/research-report/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "test",
      mode: "demo",
      input: { task: "x" },
    }),
  });
  const source = await app.request("/research-report/source");
  assert.equal(source.status, 200);
  assert.deepEqual(await source.json(), {
    method: "source",
    params: { id: "research-report" },
  });
  assert.equal((await app.request("/missing/source")).status, 404);
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { runId: "started-run" });
  assert.deepEqual(calls.find(({ method }) => method === "start")?.params, {
    requestId: "test",
    mode: "demo",
    input: { task: "x" },
    flowId: "research-report",
  });

  const history = await app.request(
    "/runs/run-id/steps/research/history?beforeSeq=10",
  );
  assert.deepEqual(((await history.json()) as { params: object }).params, {
    id: "run-id",
    stepId: "research",
    beforeSeq: 10,
  });
  for (const method of ["pause", "resume", "cancel"]) {
    const response = await app.request(`/runs/run-id/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "command" }),
    });
    assert.deepEqual(await response.json(), {
      method,
      params: { id: "run-id", requestId: "command" },
    });
  }
  for (const method of ["answer", "resolve"]) {
    const response = await app.request(
      `/runs/run-id/steps/main%2Fapproval/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "command", output: true }),
      },
    );
    assert.deepEqual(await response.json(), {
      method,
      params: {
        id: "run-id",
        stepKey: "main/approval",
        requestId: "command",
        output: true,
      },
    });
  }
  const attemptHistory = await app.request(
    "/runs/run-id/steps/main%2Fagent/history?attempt=2&beforeSeq=10",
  );
  assert.deepEqual((await attemptHistory.json()).params, {
    id: "run-id",
    stepId: "main/agent",
    attempt: 2,
    beforeSeq: 10,
  });
  assert.equal((await app.request("/runs/missing")).status, 404);
  const error = await app.request("/runs/private");
  assert.equal(error.status, 500);
  assert.doesNotMatch(await error.text(), /secret/);

  const count = calls.length;
  for (const body of ["no json", "null", "[]", '"scalar"']) {
    assert.equal(
      (
        await app.request("/research-report/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await app.request("/research-report/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(270_000),
      })
    ).status,
    413,
  );
  assert.equal(
    (await app.request("/arbitrary-rpc", { method: "POST" })).status,
    404,
  );
  assert.equal((await app.request("/elsewhere")).status, 404);
  assert.equal(calls.length, count, "invalid routes/bodies must not reach DSH");
});
