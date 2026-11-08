import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { codingTools } from "@aura/agent-runtime";
import { OrchestrationHost } from "../src/dsh/host.ts";

const nodeMajor = Number(process.versions.node.split(".")[0]);

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

/**
 * An automation task is a DSH Schedule reminder on a coding conversation.
 * When it comes due, DSH delivers it into the session outside Aura's own turn
 * path, so this covers the real service end to end: create, delivery, the
 * coding allow-list on the delivered turn, history, and deletion.
 */
test(
  "a due automation task runs in its conversation with only the coding tools",
  {
    timeout: 180_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-automation-test-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project, { recursive: true });
    await mkdir(flowRoot, { recursive: true });

    const requests: ModelRequest[] = [];
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      requests.push((await context.req.json()) as ModelRequest);
      return streamSSE(context, async (output) => {
        for (const choice of [
          { index: 0, delta: { content: "好的" }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: "stop" },
        ])
          await output.writeSSE({
            data: JSON.stringify({ choices: [choice] }),
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
    const host = new OrchestrationHost({
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    });

    try {
      const created = await host.createProject(project, "自动化");
      const sessionId = "coding-automation-session";
      // A task belongs to an existing conversation, so open one first.
      await host.coding(
        {
          sessionId,
          projectId: created.id,
          prompt: "你好",
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        () => {},
        AbortSignal.timeout(60_000),
      );

      await assert.rejects(
        host.createAutomationTask({
          sessionId: "not-a-conversation",
          title: "x",
          prompt: "x",
          timing: { kind: "daily", time: "09:00", timeZone: "UTC" },
        }),
        /对话不存在/,
      );

      const task = await host.createAutomationTask({
        sessionId,
        title: "检查构建",
        prompt: "AUTOMATION_PING",
        timing: { kind: "at", at: new Date(Date.now() + 2_000).toISOString() },
      });
      assert.equal(task.status, "active");
      assert.equal(task.conversationTitle, "好的");
      assert.deepEqual(
        (await host.automationTasks()).map(({ id }) => id),
        [task.id],
      );

      // Wait for DSH to deliver the reminder and acknowledge it.
      const deadline = Date.now() + 60_000;
      let history = await host.automationHistory(sessionId, task.id);
      while (!history.records.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        history = await host.automationHistory(sessionId, task.id);
      }
      assert.equal(history.records.length, 1, "the reminder was delivered");

      // The delivered turn reaches the model with the coding allow-list only.
      const deliveredAt = Date.now() + 30_000;
      let delivered: ModelRequest | undefined;
      while (!delivered && Date.now() < deliveredAt) {
        delivered = requests.find((request) =>
          JSON.stringify(request.messages).includes("AUTOMATION_PING"),
        );
        if (!delivered)
          await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(delivered, "the scheduled turn called the model");
      const allowed = new Set<string>([...codingTools, "bash", "pwsh"]);
      const names = (delivered.tools ?? []).map((tool) => tool.function.name);
      assert.ok(names.includes("read"), `got ${names.join(", ")}`);
      assert.deepEqual(
        names.filter((name) => !allowed.has(name)),
        [],
        "no tool outside the coding allow-list",
      );

      // A one-shot task ends after its delivery; deletion removes it.
      const [ended] = await host.automationTasks();
      assert.equal(ended?.status, "ended");
      assert.deepEqual(await host.deleteAutomationTask(sessionId, task.id), {
        deleted: true,
      });
      assert.deepEqual(await host.automationTasks(), []);
    } finally {
      await host.close();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
