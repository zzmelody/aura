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

test("model generation uses the bound worker source exchange without a legacy generation root",async()=>{
 const exchange=resolve(tmpdir(),"worker-exchange");
 await fixture(async sessionPath=>{
  const client=new VeyaWorldAgentCapability("missing-foreground.json");
  client.setRunSessionResolver(async runId=>{assert.equal(runId,"creator-child");return sessionPath;});
  assert.equal(await client.generatedOutputDirectory("creator-child"),join(exchange,"source","tripo"));
 },{protocol:"veya-world-http/1",base_url:"http://127.0.0.1:49152",token,role:"creator-worker",exchange_root:exchange});
 await fixture(async sessionPath=>{
  const client=new VeyaWorldAgentCapability(sessionPath);
  await assert.rejects(client.generatedOutputDirectory(),/model_source_exchange_unavailable/);
 });
});

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
        "veya.system.context",
        "veya.world.list",
        "veya.world.status",
        "veya.world.read",
        "veya.assets.list",
        "veya.world.create",
        "veya.world.copy",
        "veya.world.validate",
        "veya.world.apply",
        "veya.world.mode",
        "veya.world.undo",
        "veya.world.redo",
        "veya.draft.create",
        "veya.creation.module.write",
        "veya.creation.module.read",
        "veya.creation.export",
        "veya.draft.compose",
        "veya.playtest.save_resume",
        "veya.preview.performance",
        "veya.draft.read",
        "veya.draft.update",
        "veya.draft.discard",
        "veya.playtest.begin",
        "veya.playtest.end",
        "veya.character.navigate",
        "veya.character.inspect",
        "veya.character.act",
        "veya.character.cancel",
        "veya.travel.preload",
        "veya.travel.enter",
        "veya.operation.status",
        "veya.operation.cancel",
        "veya.preview.capture",
        "veya.cooker.capabilities",
        "veya.cooker.submit",
        "veya.cooker.status",
        "veya.cooker.cancel",
        "veya.runtime.observe",
        "veya.runtime.inspect",
        "veya.action.perform",
        "veya.dialogue.choose",
        "veya.player.respawn",
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

test("Veya Cooker requires the native Agent tool protocol", async () => {
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
        "veya.cooker.capabilities",
        {},
        new AbortController().signal,
      ),
      /requires veya-agent-tools\/1/u,
    );
    assert.equal(requests, 0);
  });
});

test("Veya runtime tools require the native Agent tool protocol", async () => {
  await fixture(async (sessionPath) => {
    let requests = 0;
    const request = (async () => {
      requests += 1;
      return new Response("{}");
    }) as typeof fetch;
    const client = new VeyaWorldAgentCapability(sessionPath, request);
    for (const operation of [
      "veya.system.context",
      "veya.runtime.observe",
      "veya.runtime.inspect",
      "veya.character.inspect",
      "veya.action.perform",
      "veya.dialogue.choose",
      "veya.player.respawn",
    ])
      await assert.rejects(
        client.invoke(
          VEYA_WORLD_AGENT_CAPABILITY,
          operation,
          {},
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

// The ordinary error-code test cannot cover native compose repair attribution
// or prevent a VM's source path/stack from leaking through a new diagnostic.
test("Veya failures preserve bounded typed diagnostics but reject free-form diagnostic fields", async () => {
  await fixture(async sessionPath => {
    const request = (async () => new Response(JSON.stringify({ ok: false, error: "validation_failed",
      message: "C:/private/worker/secret.lua:90 stack trace", diagnostics: [
        { code: "author_failed", stage: "author", module_id: "c".repeat(64), namespace: "prop_local", entity_id: "plaque",
          component: "dialogue", field: "text", line: 9, message: token, path: "C:/private/source.lua", stack: "secret" },
        { code: "invalid_field", component: token, field: "C:/private/source.lua", line: -1 },
        { code: "C:/private/invalid", message: token },
        { code: "ignored_fourth" },
      ] }), { status: 422 })) as typeof fetch;
    const client = new VeyaWorldAgentCapability(sessionPath, request);
    await assert.rejects(client.invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.draft.compose", {}, new AbortController().signal), (error: unknown) => {
      const text = (error as Error).message;
      assert.deepEqual(JSON.parse(text.split(" diagnostics=")[1]!), [
        { code: "author_failed", stage: "author", namespace: "prop_local", entity_id: "plaque", component: "dialogue",
          field: "text", module_id: "c".repeat(64), line: 9 }, { code: "invalid_field" },
      ]);
      assert.doesNotMatch(text, /private|secret|stack|ignored_fourth/u);
      assert.ok(!text.includes(token));
      assert.ok(text.length < 2000); return true;
    });
  }, { protocol: "veya-world-http/1", tools_protocol: "veya-agent-tools/1", base_url: "http://127.0.0.1:49152", token, pid: 42 });
});

// The canonical mapping test cannot detect a retry accidentally allocating a
// second native sampling request; performance polling must retain byte identity.
test("performance not-ready polling retains the same native request and cancellation", async () => {
  await fixture(async sessionPath => {
    const sent: string[] = [];
    const request = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify(sent.length < 3
        ? {ok:false,error:"performance_not_ready"}
        : {ok:true,data:{performance:{passed:true,p95_ms:11,p99_ms:12},content_hash:"c".repeat(64)}}), {status:sent.length < 3 ? 409 : 200});
    }) as typeof fetch;
    const client = new VeyaWorldAgentCapability(sessionPath, request);
    const input = {request_id:"stable-sample",candidate_hash:"a".repeat(64),sample_seconds:10};
    const result = await client.invoke(VEYA_WORLD_AGENT_CAPABILITY,"veya.preview.performance",input,new AbortController().signal);
    assert.equal(sent.length,3); assert.equal(new Set(sent).size,1);
    assert.equal((result as {content_hash:string}).content_hash,"c".repeat(64));
    const controller=new AbortController();
    const cancelled=new VeyaWorldAgentCapability(sessionPath,(async()=>{controller.abort();return new Response(JSON.stringify({ok:false,error:"performance_not_ready"}),{status:409});}) as typeof fetch);
    await assert.rejects(cancelled.invoke(VEYA_WORLD_AGENT_CAPABILITY,"veya.preview.performance",input,controller.signal), /abort/iu);
  }, {protocol:"veya-world-http/1",base_url:"http://127.0.0.1:49152",token,tools_protocol:"veya-agent-tools/1"});
});
