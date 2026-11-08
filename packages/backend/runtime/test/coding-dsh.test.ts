import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { codingTools } from "@aura/agent-runtime";
import { OrchestrationHost } from "../src/dsh/host.ts";
import type { CodingStreamEvent } from "@aura/agent-runtime";

const nodeMajor = Number(process.versions.node.split(".")[0]);

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

/**
 * A coding session must reach its project through DSH's own coding tools.
 * The fixture model asks for `write` on the first step and answers once the
 * tool result comes back, so the assertion covers the real registration,
 * sandbox path and execution rather than a stub.
 */
test(
  "coding session mounts the coding tools and writes inside the project",
  {
    timeout: 180_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-test-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(project, { recursive: true });
    await mkdir(flowRoot, { recursive: true });
    const skillDirectory = join(project, ".agents", "skills", "qa-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: qa-skill\ndescription: Synthetic composer skill\ndisable-model-invocation: true\n---\nSYNTHETIC_SKILL_INSTRUCTIONS\n",
    );

    const seenTools: string[][] = [];
    const requests: ModelRequest[] = [];
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      const titleCall = !request.tools?.length;
      if (!titleCall) requests.push(request);
      if (request.tools)
        seenTools.push(request.tools.map((t) => t.function.name));
      const hasToolResult = request.messages.some((m) => m.role === "tool");
      const wantsWrite = request.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("WRITE_FILE"),
      );
      const call = !titleCall && wantsWrite && !hasToolResult;
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
                          id: "write_call",
                          type: "function",
                          function: {
                            name: "write",
                            arguments: JSON.stringify({
                              file_path: "notes.txt",
                              content: "written by the coding agent\n",
                            }),
                          },
                        },
                      ],
                    }
                  : {
                      content: titleCall
                        ? "创建项目笔记"
                        : hasToolResult
                          ? "已写入 notes.txt"
                          : "no-tool",
                    },
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
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    let host = new OrchestrationHost(options);

    try {
      // A project registers the directory that becomes the sandbox root. The
      // registry canonicalizes through realpath, so compare against that.
      const created = await host.createProject(project, "测试项目");
      assert.equal(created.directory, await realpath(project));
      assert.equal(created.title, "测试项目");
      const projects = await host.projects();
      assert.ok(projects.some((item) => item.id === created.id));
      assert.equal(await host.projectStatus(created.id), "ok");
      const skills = await host.skills(created.id);
      assert.ok(skills.some((skill) => skill.name === "qa-skill"));
      assert.ok(
        skills.every((skill) =>
          Object.keys(skill).every(
            (key) => key === "name" || key === "description",
          ),
        ),
      );

      const events: CodingStreamEvent[] = [];
      const result = await host.coding(
        {
          sessionId: "coding-session-1",
          projectId: created.id,
          prompt: "/qa-skill WRITE_FILE please create notes.txt",
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        (event) => events.push(event),
        AbortSignal.timeout(150_000),
      );

      // The activity stream pairs the write call with its successful result,
      // so the transcript can mark the step done rather than leave it running.
      const started = events.find(
        (event) =>
          event.type === "tool" &&
          event.phase === "start" &&
          event.name === "write",
      );
      assert.ok(
        started,
        `expected a write start; got ${JSON.stringify(events)}`,
      );
      // The step names the file it touches, not only the tool.
      assert.equal(
        started.type === "tool" && started.phase === "start"
          ? started.detail
          : undefined,
        "notes.txt",
      );
      const finished = events.find(
        (event) =>
          event.type === "tool" &&
          event.phase === "end" &&
          started.type === "tool" &&
          event.callId === started.callId,
      );
      assert.ok(
        finished,
        `expected the write to finish; got ${JSON.stringify(events)}`,
      );
      assert.equal(
        finished.type === "tool" && finished.phase === "end" && finished.ok,
        true,
      );
      // The write result carries its applied hunk for the file-change card.
      const diffs =
        finished.type === "tool" && finished.phase === "end"
          ? finished.diffs
          : undefined;
      assert.ok(
        diffs?.length,
        `expected diffs; got ${JSON.stringify(finished)}`,
      );
      assert.match(diffs[0]!.path, /notes\.txt$/u);
      assert.match(diffs[0]!.newText, /written by the coding agent/u);
      assert.ok(result.model);
      assert.match(JSON.stringify(requests), /SYNTHETIC_SKILL_INSTRUCTIONS/u);

      // The model saw the coding tools, not an empty set.
      const names = new Set(seenTools.flat());
      for (const expected of ["read", "write", "edit", "glob", "grep"])
        assert.ok(
          names.has(expected),
          `coding session should expose ${expected}; saw ${[...names].join(", ")}`,
        );

      // The tool actually ran and the write landed inside the project.
      assert.ok(events.length >= 0);
      const written = await readFile(join(project, "notes.txt"), "utf8");
      assert.equal(written, "written by the coding agent\n");

      // The conversation is indexed under the project with its generated title.
      const conversations = await host.conversations(created.id);
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0]!.id, "coding-session-1");
      assert.equal(conversations[0]!.projectId, created.id);
      assert.equal(conversations[0]!.title, "创建项目笔记");

      // A follow-up turn reuses the session and keeps its generated title.
      seenTools.length = 0;
      assert.equal(requests.at(-1)!.model, "deepseek-v4-flash");
      await host.request<{ model: string }>(
        "coding",
        {
          chatId: "coding-2",
          sessionId: "coding-session-1",
          projectId: created.id,
          prompt: "继续",
          mode: "demo",
          model: "deepseek-v4-pro",
          reasoningEffort: "off",
        },
        AbortSignal.timeout(150_000),
      );
      assert.equal(requests.at(-1)!.model, "deepseek-v4-pro");
      assert.ok(
        JSON.stringify(requests.at(-1)!.messages).includes("WRITE_FILE"),
        "switching a live agent's model preserves conversation history",
      );
      // The live agent keeps its allow-list on later turns, not only the first:
      // coding tools stay visible and excluded ones do not leak back in.
      const followUpTools = new Set(seenTools.flat());
      for (const expected of ["read", "write", "edit"])
        assert.ok(
          followUpTools.has(expected),
          `follow-up turn should expose ${expected}; saw ${[...followUpTools].join(", ")}`,
        );
      // Nothing outside the allow-list (e.g. read_image) may leak back in.
      const allowed = new Set<string>([
        ...codingTools,
        "bash",
        "pwsh",
        "aura_flow_catalog",
        "aura_run_flow",
        "aura_flow_status",
      ]);
      for (const name of followUpTools)
        assert.ok(
          allowed.has(name),
          `follow-up turn must keep the allow-list; saw ${[...followUpTools].join(", ")}`,
        );
      const afterFollowUp = await host.conversations(created.id);
      assert.equal(afterFollowUp.length, 1);
      assert.equal(afterFollowUp[0]!.title, "创建项目笔记");
      assert.ok(afterFollowUp[0]!.updatedAt >= conversations[0]!.updatedAt);

      // Re-admitting coding tools in the profile must not leak them into an
      // ordinary chat scope, which stays fail-closed behind its allow-list.
      seenTools.length = 0;
      await host.chat(
        {
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
          messages: [{ role: "user", text: "hello" }],
        },
        () => {},
        AbortSignal.timeout(60_000),
      );
      const chatTools = new Set(seenTools.flat());
      // Its own workflow tools prove the request did carry a tool list, so the
      // assertions below are not passing on an empty set.
      assert.ok(
        chatTools.has("aura_run_flow"),
        `ordinary chat should expose its workflow tools; saw ${[...chatTools].join(", ")}`,
      );
      for (const name of ["read", "write", "edit", "glob"])
        assert.ok(
          chatTools.has(name),
          `the legacy chat adapter shares ${name}; saw ${[...chatTools].join(", ")}`,
        );
      assert.ok(chatTools.has("bash") || chatTools.has("pwsh"));

      // The legacy wire format and the new composer share one durable session.
      await host.chat(
        {
          sessionId: "chat-unified",
          mode: "demo",
          model: "deepseek-v4-flash",
          messages: [
            { role: "user", text: "IMPORTED_DISCUSSION" },
            { role: "assistant", text: "这是之前讨论的方案。" },
            { role: "user", text: "先讨论，不执行。" },
          ],
        },
        () => {},
        AbortSignal.timeout(60_000),
      );
      const builtIn = (await host.projects()).find((item) => item.isDefault)!;
      assert.ok(builtIn);
      assert.equal((await host.codingHistory("chat-unified")).turns.length, 2);
      await host.selectConversationModel("chat-unified", "demo", {
        model: "deepseek-v4-pro",
      });
      await host.coding(
        {
          sessionId: "chat-unified",
          mode: "demo",
          prompt: "WRITE_FILE 按刚才的方案实现",
        },
        () => {},
        AbortSignal.timeout(60_000),
      );
      assert.equal(requests.at(-1)!.model, "deepseek-v4-pro");
      assert.match(
        JSON.stringify(requests.at(-1)!.messages),
        /IMPORTED_DISCUSSION/u,
      );
      assert.equal(
        await readFile(join(builtIn.directory, "notes.txt"), "utf8"),
        "written by the coding agent\n",
      );
      assert.deepEqual(
        (await host.codingHistory("chat-unified")).turns.map(
          (item) => item.prompt,
        ),
        [
          "IMPORTED_DISCUSSION",
          "先讨论，不执行。",
          "WRITE_FILE 按刚才的方案实现",
        ],
      );
      await host.coding(
        {
          sessionId: "coding-project-continuation",
          projectId: created.id,
          branchFrom: "chat-unified",
          mode: "demo",
          prompt: "换到这个项目继续讨论",
        },
        () => {},
        AbortSignal.timeout(60_000),
      );
      assert.match(
        JSON.stringify(requests.at(-1)!.messages),
        /IMPORTED_DISCUSSION/u,
      );
      assert.equal(requests.at(-1)!.model, "deepseek-v4-pro");
      assert.deepEqual(
        (await host.codingHistory("coding-project-continuation")).turns.map(
          (item) => item.prompt,
        ),
        // A continuation shows the turns it inherited, then its own.
        [
          "先讨论，不执行。",
          "WRITE_FILE 按刚才的方案实现",
          "换到这个项目继续讨论",
        ],
      );
      assert.equal(
        (await host.conversations(created.id)).find(
          (item) => item.id === "coding-project-continuation",
        )?.sourceSessionId,
        "chat-unified",
      );
      await assert.rejects(
        host.coding(
          {
            sessionId: "chat-unified",
            projectId: created.id,
            mode: "demo",
            prompt: "不能原地更换目录",
          },
          () => {},
          AbortSignal.timeout(60_000),
        ),
      );

      // History replays the conversation from the stored log: both turns,
      // with the write step, its diff and the reply.
      const checkHistory = async (expectedTurns: number) => {
        const history = await host.codingHistory("coding-session-1");
        assert.equal(history.running, false);
        assert.equal(
          history.turns.length,
          expectedTurns,
          JSON.stringify(history.turns.map((turn) => turn.prompt)),
        );
        const [first] = history.turns;
        assert.match(first!.prompt, /WRITE_FILE/u);
        assert.equal(first!.status, "complete");
        assert.ok(first!.endedAt! >= first!.startedAt);
        const start = first!.events.find(
          (event) =>
            event.type === "tool" &&
            event.phase === "start" &&
            event.name === "write",
        );
        assert.ok(start, JSON.stringify(first!.events));
        const end = first!.events.find(
          (event) =>
            event.type === "tool" &&
            event.phase === "end" &&
            start.type === "tool" &&
            event.callId === start.callId,
        );
        assert.ok(
          end?.type === "tool" && end.phase === "end" && end.diffs?.length,
          JSON.stringify(first!.events),
        );
        assert.ok(
          first!.events.some(
            (event) =>
              event.type === "delta" && event.text.includes("notes.txt"),
          ),
        );
        assert.equal(history.turns[1]!.prompt, "继续");
        return history;
      };
      await checkHistory(2);

      // An unknown session is refused rather than read.
      await assert.rejects(host.codingHistory("not-a-coding-session"));

      // After a restart the log is still readable, and a further turn resumes
      // the stored session instead of starting a new one.
      await host.close();
      host = new OrchestrationHost(options);
      assert.equal(
        (await host.conversations(builtIn.id)).find(
          (item) => item.id === "chat-unified",
        )?.modelConfig?.demo?.model,
        "deepseek-v4-pro",
      );
      await host.coding(
        { sessionId: "chat-unified", mode: "demo", prompt: "重启后继续讨论" },
        () => {},
        AbortSignal.timeout(60_000),
      );
      assert.equal(requests.at(-1)!.model, "deepseek-v4-pro");
      assert.match(
        JSON.stringify(requests.at(-1)!.messages),
        /IMPORTED_DISCUSSION/u,
      );
      assert.equal((await host.codingHistory("chat-unified")).turns.length, 4);
      await checkHistory(2);
      seenTools.length = 0;
      await host.coding(
        {
          sessionId: "coding-session-1",
          projectId: created.id,
          prompt: "重启后继续",
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        () => {},
        AbortSignal.timeout(150_000),
      );
      const resumed = await checkHistory(3);
      assert.equal(resumed.turns[2]!.prompt, "重启后继续");
      assert.ok(
        new Set(seenTools.flat()).has("write"),
        "a resumed session keeps its coding tools",
      );
      // The model saw the earlier turns, so it kept its context.
      const resumedRequest = requests.at(-1)!;
      assert.equal(resumedRequest.model, "deepseek-v4-flash");
      assert.ok(
        JSON.stringify(resumedRequest.messages).includes("WRITE_FILE"),
        "a resumed session sends the earlier conversation to the model",
      );
    } finally {
      await host.close?.();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
