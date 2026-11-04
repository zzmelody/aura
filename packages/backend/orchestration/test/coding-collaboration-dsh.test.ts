import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { CodingRunIntent } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";
import type { CodingStreamEvent } from "../src/types.ts";

interface ModelMessage {
  role: string;
  content: unknown;
}

test(
  "DSH reviews plans and resumes persisted goals within Aura's request allowance",
  {
    timeout: 120_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-collaboration-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    let model: ServerType | undefined;
    let host: OrchestrationHost | undefined;
    let releaseModel!: () => void;
    const heldReply = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let sawPauseFixture!: () => void;
    const pauseFixture = new Promise<void>((resolve) => {
      sawPauseFixture = resolve;
    });
    t.after(async () => {
      releaseModel();
      await host?.close();
      model?.close();
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(project);
    await mkdir(flowRoot);

    // This synthetic model is served only on loopback.
    const requests: ModelMessage[][] = [];
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const { messages } = await context.req.json<{
        messages: ModelMessage[];
      }>();
      requests.push(messages);
      const text = (value: unknown) =>
        typeof value === "string" ? value : (JSON.stringify(value) ?? "");
      const roundAt = messages.findLastIndex((item) =>
        text(item.content).includes("<goal_round>"),
      );
      if (
        roundAt >= 0 &&
        text(messages[roundAt]?.content).includes("PAUSE_FIXTURE")
      ) {
        sawPauseFixture();
        await heldReply;
      }
      const results = messages
        .slice(roundAt + 1)
        .filter(({ role }) => role === "tool");
      let call:
        { name: string; arguments: Record<string, unknown> } | undefined;
      if (roundAt === -1 && !results.length) {
        call = {
          name: "exit_plan_mode",
          arguments: { plan: "# Fixture plan\n\nInspect the result." },
        };
      } else if (
        roundAt >= 0 &&
        !text(messages[roundAt]?.content).includes("Round: 1/")
      ) {
        const result = results[0];
        if (!result) call = { name: "get_goal", arguments: {} };
        else if (results.length === 1) {
          const value = JSON.parse(text(result.content)) as {
            goal: { id: string; revision: number };
          };
          call = {
            name: "update_goal",
            arguments: {
              goal_id: value.goal.id,
              revision: value.goal.revision,
              action: "complete",
            },
          };
        }
      }
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
                          id: `fixture_${requests.length}`,
                          type: "function",
                          function: {
                            name: call.name,
                            arguments: JSON.stringify(call.arguments),
                          },
                        },
                      ],
                    }
                  : { content: "fixture reply" },
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
    const port = await new Promise<number>((resolve, reject) => {
      model = serve(
        { fetch: modelApp.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(port),
      );
      model.once("error", reject);
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    host = new OrchestrationHost(options);
    const { id: projectId } = await host.createProject(project);
    const run = (
      driver: OrchestrationHost,
      sessionId: string,
      prompt: string,
      intent: CodingRunIntent,
      emit: (event: CodingStreamEvent) => void = () => {},
    ) =>
      driver.coding(
        {
          sessionId,
          projectId,
          prompt,
          intent,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        emit,
        AbortSignal.timeout(25_000),
      );

    const answers: Array<Promise<unknown>> = [];
    await run(host, "plan-test", "Make a plan", "plan", (event) => {
      if (event.type !== "question") return;
      const question = event.questions[0]!;
      assert.equal(question.intent?.kind, "plan-review");
      assert.match(question.detail ?? "", /Fixture plan/u);
      answers.push(
        host!.answerCoding("plan-test", event.questionId, [
          {
            id: question.id,
            selected: [question.intent!.approve],
          },
        ]),
      );
    });
    assert.equal(answers.length, 1);
    await Promise.all(answers);
    assert.match(JSON.stringify(requests[0]), /You are in plan mode/u);
    assert.doesNotMatch(JSON.stringify(requests[0]), /create_goal may infer/u);
    assert.equal((await host.codingCollaboration("plan-test")).planning, false);
    assert.equal(
      (await host.codingCollaboration("plan-test", "plan")).planning,
      true,
    );

    const saveAllowance = async (
      driver: OrchestrationHost,
      maxRequests: number,
    ) => {
      const { revision } = await driver.codingCapabilities();
      await driver.codingCapabilities({
        revision,
        maxRequests,
        autoCompact: false,
        web: false,
        subagents: false,
      });
    };
    const beforeGoal = requests.length;
    await assert.rejects(
      run(host, "goal-test", "Verify the fixture objective", "goal"),
      /额度/u,
    );
    assert.equal(requests.length, beforeGoal);
    await saveAllowance(host, 1);
    const notices: string[] = [];
    await assert.rejects(
      run(
        host,
        "goal-test",
        "Verify the fixture objective",
        "goal",
        (event) => {
          if (event.type === "notice") notices.push(event.text);
        },
      ),
    );
    assert.ok(notices.some((notice) => notice.includes("额度")));
    assert.equal(requests.length, beforeGoal + 1);
    const interrupted = (await host.codingCollaboration("goal-test")).goal;
    assert.equal(interrupted?.armed, false);
    assert.equal((await host.codingCapabilities()).usedRequests, 1);

    await host.close();
    host = new OrchestrationHost(options);
    assert.equal((await host.codingCollaboration("plan-test")).planning, true);
    assert.equal(
      (await host.codingCollaboration("goal-test")).goal?.armed,
      false,
    );
    await saveAllowance(host, 6);
    await run(host, "goal-test", "Verify the fixture objective", "resume-goal");
    const complete = (await host.codingHistory("goal-test")).collaboration
      ?.goal;
    assert.equal(complete?.phase, "complete");
    assert.equal(complete?.armed, false);
    assert.ok((complete?.roundsStarted ?? 0) >= 2);
    assert.equal(
      (await host.codingCollaboration("goal-test", "clear-goal")).goal,
      undefined,
    );

    let sawPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      sawPaused = resolve;
    });
    const running = run(
      host,
      "pause-test",
      "PAUSE_FIXTURE",
      "goal",
      (event) => {
        if (
          event.type === "collaboration" &&
          event.state.goal?.phase === "paused"
        )
          sawPaused();
      },
    );
    const stoppedTurn = assert.rejects(running);
    await Promise.race([
      pauseFixture,
      running.then(() => assert.fail("The goal ended before pause")),
    ]);
    const stopping = host.stopCoding("pause-test");
    try {
      await Promise.race([paused, stopping]);
    } finally {
      releaseModel();
    }
    assert.deepEqual(await stopping, { stopped: true });
    await stoppedTurn;
    const stopped = (await host.codingCollaboration("pause-test")).goal;
    assert.equal(stopped?.phase, "paused");
    assert.equal(stopped?.armed, false);
    assert.equal(stopped?.roundsStarted, 1);
  },
);
