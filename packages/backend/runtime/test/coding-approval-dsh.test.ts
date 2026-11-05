import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/dsh/host.ts";
import type { CodingStreamEvent } from "@aura/agent-runtime";

const nodeMajor = Number(process.versions.node.split(".")[0]);

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * The session starts read-only and the fixture model retries a command with
 * `sandbox_permissions: workspace-write`, which DSH gates on user approval.
 * The widest grant possible here is writing inside the temporary project. The real sandbox, approval service and bash tool run;
 * only the user's click is simulated. Each scenario uses its own session, so
 * "any tool result yet" tells the model which step it is on.
 */
test(
  "a sandbox escalation waits for the user and runs only when allowed",
  {
    timeout: 240_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : process.platform === "win32"
          ? "the bash tool is POSIX-only; Windows composes pwsh instead"
          : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-approval-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project, { recursive: true });
    await mkdir(flowRoot, { recursive: true });

    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      const result = request.messages.findLast((m) => m.role === "tool");
      const prompt = JSON.stringify(request.messages);
      const file = prompt.includes("REJECT") ? "rejected.txt" : "approved.txt";
      const call = !result;
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: call
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "bash_call",
                          type: "function",
                          function: {
                            name: "bash",
                            arguments: JSON.stringify({
                              command: `echo written > ${file}`,
                              description: "Write a marker file",
                              sandbox_permissions: "workspace-write",
                              justification: "测试需要更宽的权限",
                            }),
                          },
                        },
                      ],
                    }
                  : { content: `结果：${JSON.stringify(result.content)}` },
                finish_reason: null,
              },
            ],
          }),
        });
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: call ? "tool_calls" : "stop",
              },
            ],
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
    // Read-only, so the only escalation on offer stays inside the project.
    const previousMode = process.env.DSH_PERMISSION_MODE;
    process.env.DSH_PERMISSION_MODE = "read-only";
    const host = new OrchestrationHost({
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    });

    /** Runs one turn, answers the approval card with `choice`, returns events. */
    const run = async (sessionId: string, prompt: string, choice: string) => {
      const created = await host.createProject(project, "approval");
      const events: CodingStreamEvent[] = [];
      let asked: (event: CodingStreamEvent) => void = () => {};
      const question = new Promise<CodingStreamEvent>((resolve) => {
        asked = resolve;
      });
      const turn = host.coding(
        {
          sessionId,
          projectId: created.id,
          prompt,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        (event) => {
          events.push(event);
          if (event.type === "question") asked(event);
        },
        AbortSignal.timeout(200_000),
      );
      const event = await question;
      assert.ok(event.type === "question");
      const card = event.questions[0]!;
      assert.equal(card.kind, "approval");
      assert.match(card.question, /bash/u);
      assert.match(card.detail ?? "", /可写项目目录/u);
      assert.match(card.detail ?? "", /测试需要更宽的权限/u);
      // Free text cannot grant; only the option label decides.
      await host.answerCoding(sessionId, event.questionId, [
        { id: card.id, selected: [choice] },
      ]);
      await turn;
      const end = events.find(
        (item) => item.type === "tool" && item.phase === "end",
      );
      return { events, end };
    };

    try {
      // Allowed: the escalated command runs and writes its file.
      const allowed = await run(
        "approve-session",
        "ALLOW 写个标记",
        "允许这一次",
      );
      assert.ok(
        allowed.end?.type === "tool" &&
          allowed.end.phase === "end" &&
          allowed.end.ok,
        JSON.stringify(allowed.events),
      );
      assert.equal(
        (await readFile(join(project, "approved.txt"), "utf8")).trim(),
        "written",
      );

      // Rejected: the command never runs and the step fails.
      const rejected = await run("reject-session", "REJECT 写个标记", "拒绝");
      assert.ok(
        rejected.end?.type === "tool" &&
          rejected.end.phase === "end" &&
          !rejected.end.ok,
        JSON.stringify(rejected.events),
      );
      await assert.rejects(readFile(join(project, "rejected.txt"), "utf8"), {
        code: "ENOENT",
      });

      // History replays each approval card with the decision that was made.
      for (const [sessionId, label] of [
        ["approve-session", "允许这一次"],
        ["reject-session", "拒绝"],
      ] as const) {
        const history = await host.codingHistory(sessionId);
        const replayed = history.turns[0]!.events;
        const card = replayed.find((item) => item.type === "question");
        assert.ok(
          card?.type === "question" && card.questions[0]!.kind === "approval",
          JSON.stringify(replayed),
        );
        const answered = replayed.find((item) => item.type === "answered");
        assert.ok(answered?.type === "answered", JSON.stringify(replayed));
        assert.equal(answered.questionId, card.questionId);
        assert.deepEqual(answered.answers[0]!.selected, [label]);
      }
    } finally {
      if (previousMode === undefined) delete process.env.DSH_PERMISSION_MODE;
      else process.env.DSH_PERMISSION_MODE = previousMode;
      await host.close?.();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
