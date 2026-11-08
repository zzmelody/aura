import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/dsh/host.ts";
import type { CodingStreamEvent } from "@aura/agent-runtime";

test(
  "DSH generates titles without quota setup, persists them and retains failed titles without retrying",
  {
    timeout: 90_000,
    skip:
      Number(process.versions.node.split(".")[0]) < 24
        ? "DSH requires Node >=24"
        : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-titles-"));
    let host: OrchestrationHost | undefined;
    let server: ServerType | undefined;
    t.after(async () => {
      await host?.close();
      if (server) {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    const project = join(root, "project");
    const flowRoot = join(root, "flows");
    await mkdir(project);
    await mkdir(flowRoot);
    const titles: Array<{
      model: string;
      messages: unknown;
      max_tokens?: number;
      max_completion_tokens?: number;
    }> = [];
    let mainRequests = 0;
    // Synthetic local model: the test never contacts a real paid provider.
    const app = new Hono();
    app.post("/v1/chat/completions", async (context) => {
      const request = await context.req.json<{
        model: string;
        messages: unknown;
        tools?: unknown[];
        max_tokens?: number;
        max_completion_tokens?: number;
      }>();
      const title = !request.tools?.length;
      if (title) titles.push(request);
      else mainRequests++;
      const text = title
        ? JSON.stringify(request.messages).includes("EMPTY_TITLE")
          ? ""
          : JSON.stringify(request.messages).includes("SIDE_ONLY")
            ? "定位旁支消息遗漏"
            : "修复对话消息显示"
        : "Synthetic completed reply";
      return streamSSE(context, async (stream) => {
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          }),
        });
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
      });
    });
    const port = await new Promise<number>((resolve) => {
      server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(port),
      );
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    host = new OrchestrationHost(options);
    const space = await host.createProject(project);
    const send = (
      sessionId: string,
      prompt: string,
      forkFrom?: string,
      events: CodingStreamEvent[] = [],
    ) =>
      host!.coding(
        {
          sessionId,
          prompt,
          forkFrom,
          projectId: space.id,
          mode: "demo",
          model: "deepseek-v4-pro",
          reasoningEffort: "off",
        },
        (event) => events.push(event),
        AbortSignal.timeout(30_000),
      );
    await send("main", "请检查对话消息发过去之后不显示的问题");
    const side = await host.openCodingSide("main");
    await send(side.sessionId, "SIDE_ONLY 请单独排查旁支消息", "main");
    let listed = await host.conversations(space.id);
    assert.equal(listed[0]?.title, "修复对话消息显示");
    assert.equal(listed[0]?.sideConversations?.[0]?.title, "定位旁支消息遗漏");
    assert.equal(titles.length, 2);
    assert.ok(titles.every((request) => request.model === "deepseek-v4-pro"));
    assert.ok(
      titles.every(
        (request) =>
          (request.max_tokens ?? request.max_completion_tokens) === 128,
      ),
      JSON.stringify(titles),
    );
    assert.equal((await host.codingHistory("main")).turns.length, 1);
    assert.equal((await host.codingHistory(side.sessionId)).turns.length, 1);

    await send("main", "继续检查");
    await send(side.sessionId, "继续排查", "main");
    const fallback: CodingStreamEvent[] = [];
    await send("empty-title", "EMPTY_TITLE 保留临时标题", undefined, fallback);
    await send("empty-title", "继续");
    assert.equal(titles.length, 3);
    await send("another", "新对话无需设置额度");
    assert.equal(titles.length, 4);
    assert.equal(mainRequests, 7);
    assert.ok(
      fallback.some(
        (event) => event.type === "notice" && event.text.includes("临时标题"),
      ),
    );
    assert.equal((await host.codingCapabilities()).usedRequests, 4);
    assert.equal((await host.codingCapabilities()).unknownRequests, 1);
    await host.close();
    host = new OrchestrationHost(options);
    listed = await host.conversations(space.id);
    const main = listed.find((item) => item.id === "main");
    assert.equal(main?.title, "修复对话消息显示");
    assert.equal(main?.sideConversations?.[0]?.title, "定位旁支消息遗漏");
    assert.equal(
      listed.find((item) => item.id === "empty-title")?.title,
      "EMPTY_TITLE 保留临时标题",
    );
    assert.equal(
      listed.find((item) => item.id === "another")?.title,
      "修复对话消息显示",
    );
    assert.equal(titles.length, 4);
    assert.equal(mainRequests, 7);
  },
);
