import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/dsh/host.ts";
import type { CodingStreamEvent } from "@aura/agent-runtime";

test(
  "stopped steering stays in DSH's inbox after history reload and is confirmed once when the user continues",
  {
    timeout: 60_000,
    skip:
      Number(process.versions.node.split(".")[0]) < 24
        ? "DSH requires Node >=24"
        : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-stop-steer-"));
    let host: OrchestrationHost | undefined;
    let model: ServerType | undefined;
    const release = Promise.withResolvers<void>();
    t.after(async () => {
      release.resolve();
      await host?.close();
      if (model) {
        if ("closeAllConnections" in model) model.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          model!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project);
    await mkdir(flowRoot);
    const opened = Promise.withResolvers<void>();
    const requests: Array<{ messages: unknown }> = [];
    // Synthetic local model: stop the first stream before it can take guidance.
    const app = new Hono();
    app.post("/v1/chat/completions", async (context) => {
      requests.push(await context.req.json());
      const first = requests.length === 1;
      return streamSSE(context, async (stream) => {
        stream.onAbort(() => release.resolve());
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  content: first ? "checking" : "read pending guidance",
                },
                finish_reason: null,
              },
            ],
          }),
        });
        if (first) {
          opened.resolve();
          await release.promise;
          return;
        }
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
      });
    });
    const port = await new Promise<number>((resolve) => {
      model = serve(
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
    const sessionId = "stop-steer";
    const events: CodingStreamEvent[] = [];
    const send = (prompt: string) =>
      host!.coding(
        {
          sessionId,
          projectId: space.id,
          prompt,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        (event) => events.push(event),
        AbortSignal.timeout(30_000),
      );
    const first = send("检查项目");
    const stopped = assert.rejects(first);
    await opened.promise;
    const pending = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        text: "我们用的是 Angel，请不要再用 gd",
      },
      { id: "00000000-0000-4000-8000-000000000002", text: "还要检查构建配置" },
    ];
    for (const item of pending)
      assert.deepEqual(
        await host.steerCoding(sessionId, item.text, [], undefined, item.id),
        { steered: true },
      );
    assert.equal((await host.stopCoding(sessionId)).stopped, true);
    await stopped;
    assert.equal(
      requests.length,
      1,
      "stopping must not wake another model request",
    );
    const before = await host.codingHistory(sessionId);
    const restored = await host.codingHistory(sessionId);
    assert.equal(
      requests.length,
      1,
      "reading history must not wake pending input",
    );
    events.length = 0;
    await send("继续");
    assert.equal(requests.length, 2);
    const seen = JSON.stringify(requests[1]!.messages);
    for (const item of pending) assert.ok(seen.includes(item.text));
    const read = events.filter((event) => event.type === "steer");
    assert.deepEqual(
      read.map((event) => event.requestId),
      pending.map((item) => item.id),
    );
    const after = await host.codingHistory(sessionId);
    assert.deepEqual(
      after.turns.map((turn) => turn.prompt),
      ["检查项目", "继续"],
    );
    for (const history of [before, restored])
      assert.deepEqual(
        history.turns[0]?.events
          .filter((event) => event.type === "steer")
          .map((event) => ({ id: event.requestId, delivery: event.delivery })),
        pending.map((item) => ({ id: item.id, delivery: "queued" })),
      );
    assert.deepEqual(
      after.turns[0]?.events
        .filter((event) => event.type === "steer")
        .map((event) => ({ id: event.requestId, delivery: event.delivery })),
      pending.map((item) => ({ id: item.id, delivery: undefined })),
    );
    assert.equal(
      after.turns[1]?.events.some((event) => event.type === "steer"),
      false,
    );
    await host.close();
    host = new OrchestrationHost(options);
    const persisted = await host.codingHistory(sessionId);
    assert.deepEqual(persisted.turns, after.turns);
    assert.equal(requests.length, 2);
  },
);
