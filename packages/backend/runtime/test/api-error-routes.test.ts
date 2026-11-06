import assert from "node:assert/strict";
import test from "node:test";
import { CodedFlowError, FlowError } from "@aura/protocol/errors";
import { createFlowApp } from "../src/flow-routes.ts";
import { createCodingApp } from "../src/coding-routes.ts";
import { createConversationChannelApp } from "../src/conversation-channel-routes.ts";
import { createTerminalApp } from "../src/terminal-routes.ts";
import { createIntegrationApp } from "../src/integration-routes.ts";
import { createPluginPagesApp } from "../src/plugin-pages-routes.ts";
import type { PluginPageRegistry } from "../src/plugin-pages.ts";
import type { OrchestrationHost } from "../src/dsh/host.ts";

test("HTTP error projections retain codes, safe parameters, messages and established status handling", async () => {
  let error: Error = new CodedFlowError("legacy readable message", 409, {
    code: "image_too_large",
    params: { limitMiB: 32 },
  });
  Object.assign(error, {
    token: "private",
    cause: new Error("private response"),
  });
  const request = async (): Promise<never> => {
    throw error;
  };
  const host = {
    request,
    personalAssistant: request,
    transcribeVoice: request,
  };
  const pages = {
    snapshot: () => ({ bundles: [{ plugin: { id: "fixture" } }] }),
  } as unknown as PluginPageRegistry;
  const endpoints = [
    { app: createFlowApp(host), path: "/catalog" },
    {
      app: createCodingApp(host as unknown as OrchestrationHost),
      path: "/assistant",
    },
    { app: createConversationChannelApp(host), path: "/fixture/snapshot" },
    { app: createTerminalApp(host), path: "/" },
    { app: createIntegrationApp(host, true), path: "/flags" },
    {
      app: createPluginPagesApp(pages, host),
      path: "/pages/fixture/invoke",
      init: {
        method: "POST",
        body: JSON.stringify({ operation: "read" }),
        headers: { "Content-Type": "application/json" },
      },
    },
  ];
  for (const endpoint of endpoints) {
    const response = await endpoint.app.request(endpoint.path, endpoint.init);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      message: "legacy readable message",
      code: "image_too_large",
      params: { limitMiB: 32 },
    });
  }
  error = new FlowError("legacy plugin message", 409);
  for (const endpoint of endpoints)
    assert.deepEqual(
      await (await endpoint.app.request(endpoint.path, endpoint.init)).json(),
      { message: "legacy plugin message" },
    );
  error = new Error("private upstream response");
  for (const endpoint of endpoints.slice(0, -1)) {
    const response = await endpoint.app.request(endpoint.path, endpoint.init);
    const body = await response.json();
    assert.equal(typeof body.code, "string");
    assert.equal(JSON.stringify(body).includes("private"), false);
  }
});

test("Flow validation failures carry stable codes without admitting invalid requests", async () => {
  let calls = 0;
  const app = createFlowApp({
    request: async () => {
      calls++;
      throw new Error("unexpected RPC");
    },
  });
  for (const [path, init, status, code] of [
    [
      "/fixture/runs",
      { method: "POST", body: "not JSON" },
      400,
      "flow_request_invalid",
    ],
    [
      "/fixture/invoke",
      {
        method: "POST",
        body: JSON.stringify({ requestId: "body-id" }),
        headers: { "Idempotency-Key": "header-id" },
      },
      409,
      "request_id_conflict",
    ],
    ["/assets/images/file", undefined, 503, "image_service_unavailable"],
    [
      "/runs/run/artifacts/file/content",
      undefined,
      503,
      "artifact_service_unavailable",
    ],
    ["/missing", undefined, 404, "flow_endpoint_not_found"],
  ] as const) {
    const response = await app.request(path, init);
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  assert.equal(calls, 0);
});
