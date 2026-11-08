import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  AgentTeamView,
  ConversationSearchHit,
  IntegrationSettings,
} from "@aura/protocol/types";
import { OrchestrationHost } from "../src/dsh/host.ts";

test(
  "integration settings gate native search, team and MCP across coding turns and restart",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-integrations-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await Promise.all([mkdir(project), mkdir(flowRoot)]);

    // Both upstream endpoints are synthetic. No real model or MCP server is called.
    const credential = "synthetic-mcp-credential";
    const credentialName = "AURA_MCP_INTEGRATION_TEST";
    const requests: Array<{ tools: string[]; text: string }> = [];
    let mcpCalls = 0;
    const app = new Hono();
    app.get("/mcp", (context) => context.body(null, 405));
    app.post("/mcp", async (context) => {
      assert.equal(context.req.header("authorization"), `Bearer ${credential}`);
      const { id, method, params } = await context.req.json();
      if (id === undefined) return context.body(null, 202);
      let result: unknown;
      if (method === "server/discover") {
        return context.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      if (method === "initialize") {
        result = {
          protocolVersion: params.protocolVersion,
          serverInfo: { name: "synthetic", version: "1.0.0" },
          capabilities: { tools: {} },
          instructions: "Untrusted MCP instructions must stay out of prompts.",
        };
      } else if (method === "tools/list") {
        result = {
          tools: [
            { name: "ping", inputSchema: { type: "object", properties: {} } },
          ],
        };
      } else {
        assert.equal(method, "tools/call");
        mcpCalls++;
        result = {
          content: [{ type: "text", text: `synthetic output ${credential}` }],
        };
      }
      return context.json({ jsonrpc: "2.0", id, result });
    });
    app.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as {
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const text = JSON.stringify(request.messages);
      const tools = request.tools?.map(({ function: tool }) => tool.name) ?? [];
      requests.push({ tools, text });
      const alreadyCalled = request.messages.some(
        ({ role }) => role === "tool",
      );
      const tool = alreadyCalled
        ? undefined
        : text.includes("Call synthetic MCP")
          ? { name: "mcp__fixture__ping", arguments: "{}" }
          : text.includes("Create a synthetic teammate")
            ? {
                name: "spawn_teammate",
                arguments: JSON.stringify({
                  name: "reviewer",
                  description: "Synthetic review",
                  prompt: "Synthetic teammate task",
                }),
              }
            : undefined;
      return streamSSE(context, async (stream) => {
        for (const choice of tool && tools.includes(tool.name)
          ? [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_fixture",
                      type: "function",
                      function: tool,
                    },
                  ],
                },
                finish_reason: null,
              },
              { delta: {}, finish_reason: "tool_calls" },
            ]
          : [
              { delta: { content: "synthetic response" }, finish_reason: null },
              { delta: {}, finish_reason: "stop" },
            ]) {
          await stream.writeSSE({
            data: JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              model: "deepseek-v4-flash",
              choices: [{ index: 0, ...choice }],
            }),
          });
        }
        await stream.writeSSE({ data: "[DONE]" });
      });
    });
    const { server, port } = await new Promise<{
      server: ReturnType<typeof serve>;
      port: number;
    }>((resolve) => {
      const server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        (address) => resolve({ server, port: address.port }),
      );
    });
    const base = `http://127.0.0.1:${port}`;
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `${base}/v1`,
      localIntegrations: true,
    };
    const previous = process.env[credentialName];
    process.env[credentialName] = credential;
    let host = new OrchestrationHost(options);
    t.after(async () => {
      if (previous === undefined) delete process.env[credentialName];
      else process.env[credentialName] = previous;
      try {
        await host.close();
      } finally {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
    const workspace = await host.createProject(project, "Synthetic");
    const status = () =>
      host.request<IntegrationSettings>("integrations/settings");
    const initial = await status();
    assert.deepEqual(Object.values(initial.flags), [
      false,
      false,
      false,
      false,
      false,
    ]);
    const search = () =>
      host.request<ConversationSearchHit[]>("integrations/search", {
        projectId: workspace.id,
        query: "haystack",
      });
    // Conversation search no longer depends on the integration switch.
    assert.deepEqual(await search(), []);
    const run = (sessionId: string, prompt: string) =>
      host.coding(
        {
          sessionId,
          projectId: workspace.id,
          mode: "demo",
          prompt,
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
          permission: "workspace-write",
        },
        () => undefined,
        AbortSignal.timeout(20_000),
      );
    await run(
      "integration-history",
      "Find the haystack before enabling search. 这是独有的中文会话记录。",
    );
    assert.equal(
      requests.some(({ tools }) => tools.includes("spawn_teammate")),
      false,
    );
    const updated = await host.request<IntegrationSettings>(
      "integrations/save",
      {
        revision: initial.revision,
        flags: {
          ...initial.flags,
          sessionSearch: true,
          voice: true,
          agentTeam: true,
          mcp: true,
        },
        server: {
          name: "fixture",
          transport: "streamable-http",
          url: `${base}/mcp`,
          bearerEnv: credentialName,
        },
      },
    );
    assert.ok(
      ["unprepared", "checking"].includes(updated.voicePhase),
      updated.voicePhase,
    );
    await assert.rejects(
      host.request("integrations/voice/transcribe", {
        id: "b3ef150c-9781-43bb-bada-f67533654c10",
        audio: "AAAA",
      }),
      { status: 409 },
    );
    await assert.rejects(
      host.request("integrations/save", {
        revision: initial.revision,
        flags: initial.flags,
      }),
      { status: 409 },
    );
    await assert.rejects(host.request("integrations/market"), { status: 409 });
    const hits = await search();
    assert.equal(hits[0]?.id, "integration-history");
    assert.match(hits[0]?.snippet ?? "", /haystack/u);
    assert.equal(hits[0]?.projectId, workspace.id);
    assert.equal(typeof hits[0]?.seq, "number");
    // Omitting the workspace searches every workspace.
    const global = await host.request<ConversationSearchHit[]>(
      "integrations/search",
      { query: "haystack" },
    );
    assert.equal(global[0]?.id, "integration-history");
    assert.equal(global[0]?.projectId, workspace.id);
    const chinese = await host.request<ConversationSearchHit[]>(
      "integrations/search",
      {
        projectId: workspace.id,
        query: "中文会话",
      },
    );
    assert.match(chinese[0]?.snippet ?? "", /中文会话/u);
    assert.deepEqual(
      await host.request("integrations/search", {
        projectId: "different",
        query: "haystack",
      }),
      [],
    );

    let connected = await status();
    for (
      let attempt = 0;
      connected.mcpServers[0]?.status === "connecting" && attempt < 50;
      attempt++
    ) {
      await delay(100);
      connected = await status();
    }
    assert.deepEqual(connected.mcpServers, [
      {
        name: "fixture",
        transport: "streamable-http",
        status: "connected",
        tools: ["mcp__fixture__ping"],
      },
    ]);
    assert.ok(!JSON.stringify(connected).includes(credential));
    const beforeMcp = (await host.codingCapabilities()).usedRequests;
    await host.codingCapabilities({
      revision: 0,
      autoCompact: false,
      web: false,
      subagents: false,
    });
    await run("integration-mcp", "Call synthetic MCP");
    assert.equal(mcpCalls, 1);
    assert.equal(
      requests.some(({ text }) => text.includes(credential)),
      false,
    );
    assert.equal(
      requests.some(({ text }) => text.includes("Untrusted MCP instructions")),
      false,
    );
    // The MCP call and this new conversation's title each reserve one request.
    assert.equal((await host.codingCapabilities()).usedRequests, beforeMcp + 2);

    await run("integration-team", "Create a synthetic teammate");
    assert.ok(
      requests.some(
        ({ text, tools }) =>
          text.includes("Create a synthetic teammate") &&
          tools.includes("spawn_teammate"),
      ),
    );
    const team = await host.request<AgentTeamView>("integrations/team", {
      id: "integration-team",
    });
    assert.ok(team.members.some(({ name }) => name === "reviewer"));
    assert.ok((await host.codingCapabilities()).usedRequests > 1);

    await host.request("integrations/save", {
      revision: connected.revision,
      flags: { ...initial.flags, sessionSearch: true },
    });
    await run("integration-off", "Call synthetic MCP after disabling");
    assert.equal(requests.at(-1)?.tools.includes("mcp__fixture__ping"), false);
    assert.equal(requests.at(-1)?.tools.includes("spawn_teammate"), false);
    assert.equal(mcpCalls, 1);
    await host.close();
    host = new OrchestrationHost(options);
    assert.equal((await status()).mcpServers[0]?.status, "disabled");
    assert.equal((await search())[0]?.id, "integration-history");
    const afterRestart = await status();
    assert.equal(afterRestart.voicePhase, "disabled");
    const count = requests.length;
    await host.request("integrations/save", {
      revision: afterRestart.revision,
      flags: { ...afterRestart.flags, agentTeam: true },
    });
    const cold = await host.request<AgentTeamView>("integrations/team", {
      id: "integration-team",
    });
    assert.ok(cold.members.some(({ name }) => name === "reviewer"));
    assert.equal(requests.length, count);
  },
);
