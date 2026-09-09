import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OrchestrationHost } from "../src/index.ts";
import { flowDemoReply } from "../src/demo.ts";

test(
  "real DSH: different presets, selected-output coordinator, durable cold session history",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-flow-test-"));
    const calls = [];
    const model = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(request);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const reply = () =>
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: flowDemoReply(request.messages) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      if (JSON.stringify(request.messages).includes("slow-task")) {
        res.write(": waiting\n\n");
        const timer = setTimeout(reply, 15000);
        res.on("close", () => clearTimeout(timer));
      } else reply();
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const options = {
      root,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${model.address().port}/v1`,
    };
    let host = new OrchestrationHost(options);
    try {
      const catalog = await host.request("catalog");
      assert.equal(catalog.presets.filter((p) => !p.unavailable).length, 3);
      const definition = {
        ...catalog.definitions[0].definition,
        coordinator: {
          ...catalog.definitions[0].definition.coordinator,
          sources: ["research"],
        },
      };
      await host.request("save", { definition });
      const request = {
        requestId: randomUUID(),
        definitionId: definition.id,
        task: "验证流程",
        mode: "demo",
      };
      let run = await host.request("start", request);
      assert.equal((await host.request("start", request)).id, run.id);
      const deadline = Date.now() + 30000;
      while (
        ["running", "queued"].includes(run.status) &&
        Date.now() < deadline
      ) {
        await delay(100);
        run = await host.request("get", { id: run.id });
      }
      assert.equal(run.status, "completed", JSON.stringify(run));
      assert.equal(new Set(run.steps.map((s) => s.sessionId)).size, 3);
      assert.equal(calls.length, 3);
      assert.match(run.report, /来源 research/);
      assert.doesNotMatch(run.report, /来源 review/);
      const systemTexts = calls.map((c) =>
        JSON.stringify(c.messages.filter((m) => m.role === "system")),
      );
      assert.ok(systemTexts.some((s) => s.includes("research analyst")));
      assert.ok(
        systemTexts.some((s) => s.includes("independent risk reviewer")),
      );
      assert.ok(systemTexts.some((s) => s.includes("coordinator")));
      const history = await host.request("history", {
        id: run.id,
        stepId: "coordinator",
      });
      assert.ok(
        history.entries.some(
          (e) => e.kind === "assistant" && e.text === run.report,
        ),
      );
      const older = await host.request("history", {
        id: run.id,
        stepId: "coordinator",
        beforeSeq: history.entries.find((entry) => entry.kind === "assistant")
          .seq,
      });
      assert.ok(older.entries.some((entry) => entry.kind === "user"));
      assert.ok(older.entries.every((entry) => entry.kind !== "assistant"));
      await host.close();
      host = new OrchestrationHost(options);
      const restored = await host.request("get", { id: run.id });
      assert.equal(restored.report, run.report);
      const cold = await host.request("history", {
        id: run.id,
        stepId: "research",
      });
      assert.equal(cold.preset, "researcher-v1");
      assert.ok(cold.entries.some((e) => e.kind === "assistant"));
      assert.equal(
        calls.length,
        3,
        "reading history must not start an agent/model call",
      );
      const cancelledRun = await host.request("start", {
        ...request,
        requestId: randomUUID(),
        task: "slow-task cancel",
      });
      while (calls.length < 5) await delay(20);
      const cancelled = await host.request("cancel", { id: cancelledRun.id });
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.steps.every((step) => step.status === "cancelled"));
      assert.equal(
        calls.length,
        5,
        "cancelled nodes must not dispatch the coordinator",
      );
      const cancelledHistory = await host.request("history", {
        id: cancelled.id,
        stepId: "research",
      });
      assert.ok(
        cancelledHistory.entries.some((entry) => entry.kind === "event"),
      );
      await host.request("save", {
        definition: { ...definition, timeoutMs: 1000, concurrency: 1 },
      });
      let timed = await host.request("start", {
        ...request,
        requestId: randomUUID(),
        task: "slow-task timeout",
      });
      const timeoutDeadline = Date.now() + 8000;
      while (
        ["queued", "running"].includes(timed.status) &&
        Date.now() < timeoutDeadline
      ) {
        await delay(100);
        timed = await host.request("get", { id: timed.id });
      }
      assert.equal(timed.status, "failed");
      assert.equal(timed.steps[1].status, "skipped");
      // Crash recovery also preserves the same request ID; no uncertain work is replayed.
      await host.request("save", { definition });
      const crashRequest = {
        ...request,
        requestId: randomUUID(),
        task: "slow-task crash",
      };
      const crashed = await host.request("start", crashRequest);
      const processHandle = await host.open();
      processHandle.child.kill();
      await processHandle.exited;
      const recovered = await host.request("get", { id: crashed.id });
      assert.equal(recovered.status, "interrupted");
      assert.equal((await host.request("start", crashRequest)).id, crashed.id);
    } finally {
      await host.close();
      await new Promise((resolve) => {
        model.close(resolve);
        model.closeAllConnections();
      });
      // Validate the exact generated target before recursive cleanup on Windows.
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("aura-flow-test-"));
      await rm(root, { recursive: true, force: true });
    }
  },
);
