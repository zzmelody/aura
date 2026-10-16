import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/index.ts";

const nodeMajor = Number(process.versions.node.split(".")[0]);

test(
  "side chats survive host restart, resume their own context, and disappear only on closure or parent archival",
  {
    timeout: 180_000,
    skip: nodeMajor < 24 ? "DSH requires Node >=24" : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-side-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project);
    await mkdir(flowRoot);
    const requests: unknown[] = [];
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      requests.push(await context.req.json());
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "fixture reply" },
                finish_reason: null,
              },
            ],
          }),
        });
        await output.writeSSE({
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await output.writeSSE({ data: "[DONE]" });
      });
    });
    let model!: ServerType;
    const port = await new Promise<number>((done, fail) => {
      model = serve(
        { fetch: modelApp.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => done(port),
      );
      model.once("error", fail);
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    let host = new OrchestrationHost(options);
    try {
      const space = await host.createProject(project);
      const turn = (sessionId: string, prompt: string, forkFrom?: string) =>
        host.coding(
          {
            sessionId,
            projectId: space.id,
            prompt,
            ...(forkFrom ? { forkFrom } : {}),
            mode: "demo",
            model: "deepseek-v4-flash",
            reasoningEffort: "off",
          },
          () => {},
          AbortSignal.timeout(60_000),
        );
      await turn("main-a", "PARENT_ONLY_CONTEXT");
      await turn("main-b", "OTHER_PARENT_CONTEXT");
      const { sessionId: sideA } = await host.openCodingSide("main-a");
      const { sessionId: blankSide } = await host.openCodingSide("main-b");
      assert.equal((await host.openCodingSide("main-a")).sessionId, sideA);
      assert.deepEqual(await host.codingHistory(blankSide), {
        turns: [],
        running: false,
      });
      await turn(sideA, "SIDE_ONLY_CONTEXT", "main-a");
      assert.ok(
        JSON.stringify(requests.at(-1)).includes("PARENT_ONLY_CONTEXT"),
      );
      assert.deepEqual(
        (await host.codingHistory(sideA)).turns.map((item) => item.prompt),
        ["SIDE_ONLY_CONTEXT"],
        "inherited main turns must not appear as side history",
      );
      assert.equal((await host.conversations(space.id)).length, 2);
      await assert.rejects(turn(sideA, "wrong parent", "main-b"));
      await assert.rejects(host.codingHistory("side-unregistered"));

      await host.close();
      host = new OrchestrationHost(options);
      const restored = await host.conversations(space.id);
      assert.equal(
        restored.find((item) => item.id === "main-a")?.sideSessionId,
        sideA,
      );
      assert.equal(
        restored.find((item) => item.id === "main-b")?.sideSessionId,
        blankSide,
      );
      assert.deepEqual(
        (await host.codingHistory(sideA)).turns.map((item) => item.prompt),
        ["SIDE_ONLY_CONTEXT"],
      );
      await turn(sideA, "SIDE_AFTER_RESTART", "main-a");
      const resumed = JSON.stringify(requests.at(-1));
      assert.ok(resumed.includes("PARENT_ONLY_CONTEXT"));
      assert.ok(resumed.includes("SIDE_ONLY_CONTEXT"));
      assert.ok(!resumed.includes("OTHER_PARENT_CONTEXT"));
      assert.equal((await host.codingHistory(sideA)).turns.length, 2);

      // Cold closure works even if no side agent has been resumed in this host.
      assert.equal((await host.closeCodingSide(blankSide)).closed, true);
      assert.equal((await host.closeCodingSide(blankSide)).closed, false);
      await assert.rejects(host.codingHistory(blankSide));
      const { sessionId: nextSide } = await host.openCodingSide("main-b");
      assert.notEqual(nextSide, blankSide);
      await assert.rejects(turn(blankSide, "do not resurrect", "main-b"));

      await host.archiveCodingConversation("main-a", true);
      await assert.rejects(host.codingHistory(sideA));
      await assert.rejects(host.openCodingSide("main-a"));
      await host.archiveCodingConversation("main-a", false);
      assert.equal(
        (await host.conversations(space.id)).find(
          (item) => item.id === "main-a",
        )?.sideSessionId,
        undefined,
      );
      await host.closeCodingConversation("main-b");
      await assert.rejects(host.codingHistory(nextSide));
      await assert.rejects(host.openCodingSide("main-b"));

      await host.close();
      host = new OrchestrationHost(options);
      const final = await host.conversations(space.id);
      assert.deepEqual(
        final.map((item) => item.id),
        ["main-a"],
      );
      assert.equal(final[0]!.sideSessionId, undefined);
      await assert.rejects(host.codingHistory(sideA));
      await assert.rejects(host.codingHistory(nextSide));
      await assert.rejects(turn("main-b", "delayed parent request"));
    } finally {
      await host.close();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
