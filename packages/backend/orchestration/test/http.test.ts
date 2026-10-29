import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFlowApp, type OrchestrationHost } from "../src/index.ts";
import { FlowError } from "../src/schema.ts";
import { Hono } from "hono";

test("mounted plugin binary routes retain their own upload limits and precede generic Flow routing", async () => {
  const flows = createFlowApp({
    request: async <T>() => ({ flows: [] }) as T,
    pluginHttp: async (request) => {
      if (new URL(request.url).pathname !== "/flows/example/assets") return;
      return new Response(String((await request.arrayBuffer()).byteLength), {
        status: 201,
      });
    },
  });
  const app = new Hono().route("/flows", flows);
  const response = await app.request("/flows/example/assets", {
    method: "POST",
    body: new Uint8Array(300 * 1024),
  });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), String(300 * 1024));
  assert.equal((await app.request("/flows/catalog")).status, 200);
  assert.equal((await app.request("/flows/missing")).status, 404);
});

test("Hono boundary delegates flow operations, bounds bodies and hides internal errors", async () => {
  const calls: Array<{ method: string; params: object }> = [];
  const host: Pick<OrchestrationHost, "request"> = {
    async request<T>(method: string, params: object = {}): Promise<T> {
      calls.push({ method, params });
      if ("id" in params && params.id === "missing")
        throw new FlowError("流程运行不存在。", 404);
      if ("id" in params && params.id === "private")
        throw new Error("secret provider value");
      if (method === "catalog")
        return {
          flows: [
            {
              id: "public-flow",
              title: "Public",
              description: "",
              available: true,
              service: true,
            },
            {
              id: "internal-flow",
              title: "Internal",
              description: "",
              available: true,
              service: false,
            },
          ],
          presets: [],
        } as T;
      if (method === "start")
        return {
          id: "started-run",
          requestId: (params as { requestId: string }).requestId,
          status: "queued",
        } as T;
      return { method, params } as T;
    },
  };
  const app = createFlowApp(host);

  const catalog = await app.request("/catalog");
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  assert.equal(
    ((await catalog.json()) as { flows: unknown[] }).flows.length,
    2,
  );

  const services = await app.request("/services");
  assert.deepEqual(await services.json(), {
    flows: [
      {
        id: "public-flow",
        title: "Public",
        description: "",
        available: true,
        service: true,
        invokePath: "/flows/public-flow/invoke",
      },
    ],
  });

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
  const servicesFlowSource = await app.request("/services/source");
  assert.deepEqual(await servicesFlowSource.json(), {
    method: "source",
    params: { id: "services" },
  });
  const pluginSource = await app.request("/example.creative%2Fbrief/source");
  assert.deepEqual(await pluginSource.json(), {
    method: "source",
    params: { id: "example.creative/brief" },
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

  const invocationId = "0876c236-1fc9-44ce-9f4a-e25244cde371";
  const invoked = await app.request("/public-flow/invoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": invocationId,
    },
    body: JSON.stringify({ mode: "demo", input: { task: "service" } }),
  });
  assert.equal(invoked.status, 202);
  assert.equal(invoked.headers.get("location"), "/flows/runs/started-run");
  assert.deepEqual(await invoked.json(), {
    runId: "started-run",
    requestId: invocationId,
    status: "queued",
    links: {
      self: "/flows/runs/started-run",
      cancel: "/flows/runs/started-run/cancel",
    },
  });
  assert.deepEqual(
    calls.filter(({ method }) => method === "start").at(-1)?.params,
    {
      requestId: invocationId,
      mode: "demo",
      input: { task: "service" },
      flowId: "public-flow",
      serviceOnly: true,
    },
  );
  assert.equal(
    (
      await app.request("/public-flow/invoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": invocationId,
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          mode: "demo",
          input: {},
        }),
      })
    ).status,
    409,
  );

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
