import type {} from "@deepseek-ai/dsh-plan-mode";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionSeq as sessionSeq } from "@deepseek-ai/dsh-session";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { OrchestrationHost } from "../src/dsh/host.ts";
import type { WorkspaceTerminalInfo } from "@aura/protocol/types";

const nodeMajor = Number(process.versions.node.split(".")[0]);

test(
  "side chats survive host restart, resume their own context, and disappear only on closure or parent archival",
  {
    timeout: 180_000,
    skip: nodeMajor < 24 ? "DSH requires Node >=24" : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-side-"));
    // The real PTY must not run personal zsh startup hooks or write user history.
    const shellEnvironment = {
      ZDOTDIR: process.env.ZDOTDIR,
      HISTFILE: process.env.HISTFILE,
    };
    process.env.ZDOTDIR = root;
    process.env.HISTFILE = join(root, "shell-history");
    t.after(() => {
      for (const [key, value] of Object.entries(shellEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    await mkdir(project);
    await mkdir(flowRoot);
    const requests: Array<{
      messages: Array<{ role: string; content: unknown }>;
    }> = [];
    const lastSystemPrompt = () =>
      JSON.stringify(
        requests.at(-1)?.messages.filter(({ role }) => role === "system") ?? [],
      );
    const sideTaskRule = /以侧边会话中的用户消息确定当前任务/u;
    const planModeRule = /You are in plan mode\./u;
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
            usage: {
              prompt_tokens: 23,
              completion_tokens: 5,
              total_tokens: 28,
            },
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
      const terminal = await host.request<WorkspaceTerminalInfo>(
        "coding/terminals/open",
        { projectId: space.id, cols: 80, rows: 24 },
      );
      assert.equal(terminal.projectId, space.id);
      const terminalList = await host.request<WorkspaceTerminalInfo[]>(
        "coding/terminals/list",
        { projectId: space.id },
      );
      assert.equal(terminalList[0]?.id, terminal.id);
      assert.equal(terminalList[0]?.status, "running");
      await host.request("coding/terminals/resize", {
        terminalId: terminal.id,
        cols: 100,
        rows: 30,
      });
      await host.request("coding/terminals/close", {
        terminalId: terminal.id,
        force: true,
      });
      assert.deepEqual(
        await host.request("coding/terminals/list", { projectId: space.id }),
        [],
      );
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
      assert.doesNotMatch(lastSystemPrompt(), sideTaskRule);
      await turn("main-b", "OTHER_PARENT_CONTEXT");
      const { sessionId: sideA } = await host.openCodingSide("main-a");
      const { sessionId: blankSide } = await host.openCodingSide("main-b");
      const { sessionId: sibling } = await host.openCodingSide("main-a");
      assert.notEqual(sibling, sideA);
      const blankHistory = await host.codingHistory(blankSide);
      assert.deepEqual(blankHistory.turns, []);
      assert.equal(blankHistory.running, false);
      await turn(sideA, "SIDE_ONLY_CONTEXT", "main-a");
      assert.ok(
        JSON.stringify(requests.at(-1)).includes("PARENT_ONLY_CONTEXT"),
      );
      assert.match(lastSystemPrompt(), sideTaskRule);
      assert.match(lastSystemPrompt(), /只有用户在侧边明确要求继续/u);
      await turn(sibling, "SIBLING_ONLY_CONTEXT", "main-a");
      assert.ok(
        JSON.stringify(requests.at(-1)).includes("PARENT_ONLY_CONTEXT"),
      );
      assert.ok(!JSON.stringify(requests.at(-1)).includes("SIDE_ONLY_CONTEXT"));
      assert.deepEqual(
        (await host.codingHistory(sideA)).turns.map((item) => item.prompt),
        ["SIDE_ONLY_CONTEXT"],
        "inherited main turns must not appear as side history",
      );
      assert.equal((await host.conversations(space.id)).length, 2);
      await assert.rejects(turn(sideA, "wrong parent", "main-b"));
      await assert.rejects(host.codingHistory("side-unregistered"));

      await host.close();
      // Simulate a stored DSH plan-mode selection from a different client.
      const storage = new Context();
      try {
        await storage.plugin(JsonlSessionPersistence, {
          root: join(options.dshHome, "aura-flow-sessions"),
          compression: "none",
        });
        const handle = await storage.sessionPersistence.open(
          SessionId("main-b"),
          "write",
        );
        try {
          const { events } = await handle.read();
          const last = events.at(-1);
          assert.ok(last);
          await handle.append([
            {
              type: "plan/mode",
              seq: sessionSeq(last.seq + 1),
              time: Date.now(),
              data: { active: true },
            },
          ]);
        } finally {
          await handle.close();
        }
      } finally {
        await storage.root.fiber.dispose();
      }
      host = new OrchestrationHost(options);
      const restored = await host.conversations(space.id);
      assert.equal(
        restored.find((item) => item.id === "main-a")?.sideSessionId,
        sideA,
      );
      assert.deepEqual(
        restored
          .find((item) => item.id === "main-a")
          ?.sideConversations?.map((item) => item.id),
        [sideA, sibling],
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
      assert.ok(!resumed.includes("SIBLING_ONLY_CONTEXT"));
      assert.match(lastSystemPrompt(), sideTaskRule);
      assert.equal((await host.codingHistory(sideA)).turns.length, 2);
      const paged = await host.codingHistory(sideA, { page: true });
      assert.deepEqual(
        paged.turns.map((item) => item.prompt),
        ["SIDE_ONLY_CONTEXT", "SIDE_AFTER_RESTART"],
      );
      assert.equal(paged.hasMore, false);
      assert.equal(typeof paged.throughSeq, "number");

      // Branching from the first side reply must omit its later turn, while
      // retaining the context the side inherited from its parent.
      const branchAt = paged.turns[0]?.endSeq;
      assert.equal(typeof branchAt, "number");
      let endSeq: number | undefined;
      let streamedUsage;
      await host.coding(
        {
          sessionId: "branched-from-side",
          projectId: space.id,
          branchFrom: sideA,
          branchAt,
          prompt: "INDEPENDENT_REPLY",
          mode: "demo",
        },
        (event) => {
          if (event.type === "turn-boundary") endSeq = event.endSeq;
          if (event.type === "usage") streamedUsage = event.usage;
        },
        AbortSignal.timeout(60_000),
      );
      const branchedRequest = JSON.stringify(requests.at(-1));
      assert.match(branchedRequest, /PARENT_ONLY_CONTEXT/u);
      assert.match(branchedRequest, /SIDE_ONLY_CONTEXT/u);
      assert.doesNotMatch(branchedRequest, /SIDE_AFTER_RESTART/u);
      assert.doesNotMatch(lastSystemPrompt(), sideTaskRule);
      const branch = await host.codingHistory("branched-from-side", {
        page: true,
      });
      assert.equal(typeof endSeq, "number");
      const usage = branch.turns[0]?.events.find(
        (event) => event.type === "usage",
      )?.usage;
      assert.equal(usage?.totalTokens, 28);
      assert.equal(usage.uncachedInputTokens, 23);
      assert.equal(usage.outputTokens, 5);
      assert.deepEqual(streamedUsage, usage);
      // A fork shows the turns it inherited as part of its own history.
      assert.deepEqual(
        branch.turns.map((item) => item.prompt),
        ["PARENT_ONLY_CONTEXT", "SIDE_ONLY_CONTEXT", "INDEPENDENT_REPLY"],
      );
      assert.equal(branch.turns.at(-1)?.endSeq, endSeq);
      await host.closeCodingConversation("branched-from-side");

      // Forking saves a conversation at once; before its first message its
      // history is the source through the selected turn.
      const { conversation: saved } = await host.forkCodingConversation(
        sideA,
        branchAt,
      );
      assert.equal(saved.sourceSessionId, sideA);
      assert.ok(
        (await host.conversations(space.id)).some(
          (item) => item.id === saved.id,
        ),
      );
      assert.deepEqual(
        (await host.codingHistory(saved.id, { page: true })).turns.map(
          (item) => item.prompt,
        ),
        ["PARENT_ONLY_CONTEXT", "SIDE_ONLY_CONTEXT"],
      );
      // Forking an unsent fork again starts from the same source.
      const { conversation: again } = await host.forkCodingConversation(
        saved.id,
        branchAt,
      );
      assert.equal(again.sourceSessionId, sideA);
      await host.coding(
        {
          sessionId: saved.id,
          projectId: space.id,
          mode: "demo",
          prompt: "FORK_FIRST_MESSAGE",
        },
        () => {},
        AbortSignal.timeout(60_000),
      );
      const forkRequest = JSON.stringify(requests.at(-1));
      assert.match(forkRequest, /SIDE_ONLY_CONTEXT/u);
      assert.doesNotMatch(forkRequest, /SIDE_AFTER_RESTART/u);
      assert.deepEqual(
        (await host.codingHistory(saved.id, { page: true })).turns.map(
          (item) => item.prompt,
        ),
        ["PARENT_ONLY_CONTEXT", "SIDE_ONLY_CONTEXT", "FORK_FIRST_MESSAGE"],
      );
      await host.closeCodingConversation(saved.id);
      await host.closeCodingConversation(again.id);

      // Cold closure works even if no side agent has been resumed in this host.
      assert.equal((await host.closeCodingSide(blankSide)).closed, true);
      assert.equal((await host.closeCodingSide(blankSide)).closed, false);
      await assert.rejects(host.codingHistory(blankSide));
      const { sessionId: nextSide } = await host.openCodingSide("main-b");
      assert.notEqual(nextSide, blankSide);
      await assert.rejects(turn(blankSide, "do not resurrect", "main-b"));
      await turn("main-b", "PLAN_THE_PARENT_TASK");
      assert.match(lastSystemPrompt(), planModeRule);
      await turn(nextSide, "IMPLEMENT_A_NEW_SIDE_TASK", "main-b");
      assert.match(JSON.stringify(requests.at(-1)), /PLAN_THE_PARENT_TASK/u);
      assert.match(lastSystemPrompt(), sideTaskRule);
      assert.doesNotMatch(lastSystemPrompt(), planModeRule);
      await turn("main-b", "REFINE_THE_PARENT_PLAN");
      assert.match(lastSystemPrompt(), planModeRule);

      await host.archiveCodingConversation("main-a", true);
      await assert.rejects(host.codingHistory(sideA));
      await assert.rejects(host.codingHistory(sibling));
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
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);
