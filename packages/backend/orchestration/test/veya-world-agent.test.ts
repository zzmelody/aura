import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  VEYA_WORLD_AGENT_CAPABILITY,
  VeyaWorldAgentCapability,
} from "../src/veya-world-agent.ts";

const token = "a".repeat(64);

async function fixture(
  run: (sessionPath: string) => Promise<void>,
  descriptor: Record<string, unknown> = {
    protocol: "veya-world-http/1",
    base_url: "http://127.0.0.1:49152",
    token,
    pid: 42,
  },
) {
  const root = await mkdtemp(join(tmpdir(), "aura-veya-world-agent-"));
  const sessionPath = join(root, "session.json");
  await writeFile(sessionPath, JSON.stringify(descriptor));
  try {
    await run(sessionPath);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("aura-veya-world-agent-"));
    await rm(root, { recursive: true, force: true });
  }
}

test("Veya capability maps fixed operations and keeps bearer auth host-side", async () =>
  fixture(async (sessionPath) => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const request = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({
          ok: true,
          data: { operation_id: "op-1", status: "queued" },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new VeyaWorldAgentCapability(sessionPath, request);
    const result = await client.invoke(
      VEYA_WORLD_AGENT_CAPABILITY,
      "veya.world.apply",
      { world_id: "owned" },
      new AbortController().signal,
    );

    assert.deepEqual(result, { operation_id: "op-1", status: "queued" });
    assert.equal(captured?.url, "http://127.0.0.1:49152/v2/worlds/apply");
    assert.equal(captured?.init?.method, "POST");
    assert.equal(
      (captured?.init?.headers as Record<string, string>).Authorization,
      `Bearer ${token}`,
    );
    assert.equal(captured?.init?.body, JSON.stringify({ world_id: "owned" }));
  }));

test("Veya capability preserves canonical tool names on the native Agent protocol", async () =>
  fixture(
    async (sessionPath) => {
      const captured: Array<{ url: string; init?: RequestInit }> = [];
      const request = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        captured.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, data: { worlds: [] } }));
      }) as typeof fetch;
      const client = new VeyaWorldAgentCapability(sessionPath, request);
      const tools = [
        "veya.world.list",
        "veya.world.status",
        "veya.world.read",
        "veya.assets.list",
        "veya.world.create",
        "veya.world.copy",
        "veya.world.validate",
        "veya.world.apply",
        "veya.travel.preload",
        "veya.travel.enter",
        "veya.operation.status",
        "veya.operation.cancel",
        "veya.preview.capture",
      ];
      for (const tool of tools)
        await client.invoke(
          VEYA_WORLD_AGENT_CAPABILITY,
          tool,
          { marker: tool },
          new AbortController().signal,
        );

      assert.deepEqual(
        captured.map(({ url, init }) => ({
          url,
          body: JSON.parse(String(init?.body)) as unknown,
        })),
        tools.map((tool) => ({
          url: "http://127.0.0.1:49152/agent/v1/call",
          body: { tool, arguments: { marker: tool } },
        })),
      );
    },
    {
      protocol: "veya-world-http/1",
      tools_protocol: "veya-agent-tools/1",
      base_url: "http://127.0.0.1:49152",
      token,
    },
  ));

test("Veya preview capture requires the native Agent tool protocol", async () => {
  await fixture(async (sessionPath) => {
    let requests = 0;
    const request = (async () => {
      requests += 1;
      return new Response("{}");
    }) as typeof fetch;
    const client = new VeyaWorldAgentCapability(sessionPath, request);
    await assert.rejects(
      client.invoke(
        VEYA_WORLD_AGENT_CAPABILITY,
        "veya.preview.capture",
        {
          world_id: "owned",
          instance_id: "instance",
          expected_revision: 1,
          request_id: "preview",
        },
        new AbortController().signal,
      ),
      /requires veya-agent-tools\/1/u,
    );
    assert.equal(requests, 0);
  });
});

test("Veya capability rejects undeclared operations before network access", async () =>
  fixture(async (sessionPath) => {
    let requests = 0;
    const request = (async () => {
      requests += 1;
      return new Response("{}");
    }) as typeof fetch;
    const client = new VeyaWorldAgentCapability(sessionPath, request);
    await assert.rejects(
      client.invoke(
        VEYA_WORLD_AGENT_CAPABILITY,
        "raw.request",
        {},
        new AbortController().signal,
      ),
      /Unsupported Veya World Agent operation/u,
    );
    assert.equal(requests, 0);
  }));

test("Veya capability requires an exact loopback descriptor and sanitizes failures", async () => {
  await fixture(
    async (sessionPath) => {
      const client = new VeyaWorldAgentCapability(sessionPath, fetch);
      await assert.rejects(
        client.invoke(
          VEYA_WORLD_AGENT_CAPABILITY,
          "veya.world.list",
          {},
          new AbortController().signal,
        ),
        /loopback origin/u,
      );
    },
    {
      protocol: "veya-world-http/1",
      base_url: "http://localhost:49152",
      token,
    },
  );

  await fixture(async (sessionPath) => {
    const request = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "revision_conflict",
          message: "The world changed.",
        }),
        { status: 409 },
      )) as typeof fetch;
    const client = new VeyaWorldAgentCapability(sessionPath, request);
    await assert.rejects(
      client.invoke(
        VEYA_WORLD_AGENT_CAPABILITY,
        "veya.world.apply",
        {},
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.match(String(error), /revision_conflict.*world changed/u);
        assert.doesNotMatch(String(error), new RegExp(token, "u"));
        return true;
      },
    );
  });
});
