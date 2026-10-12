import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/index.ts";
import type { CodingStreamEvent } from "../src/types.ts";

const nodeMajor = Number(process.versions.node.split(".")[0]);

interface ModelRequest {
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

    const seenTools: string[][] = [];
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      if (request.tools)
        seenTools.push(request.tools.map((t) => t.function.name));
      const hasToolResult = request.messages.some((m) => m.role === "tool");
      const wantsWrite = request.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("WRITE_FILE"),
      );
      const call = wantsWrite && !hasToolResult;
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
                      content: hasToolResult ? "已写入 notes.txt" : "no-tool",
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
    const host = new OrchestrationHost({
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    });

    try {
      // A project registers the directory that becomes the sandbox root. The
      // registry canonicalizes through realpath, so compare against that.
      const created = await host.createProject(project, "测试项目");
      assert.equal(created.directory, await realpath(project));
      assert.equal(created.title, "测试项目");
      const projects = await host.projects();
      assert.ok(projects.some((item) => item.id === created.id));
      assert.equal(await host.projectStatus(created.id), "ok");

      const events: CodingStreamEvent[] = [];
      const result = await host.coding(
        {
          sessionId: "coding-session-1",
          projectId: created.id,
          prompt: "WRITE_FILE please create notes.txt",
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

      // The conversation is indexed under the project, titled by its first turn.
      const conversations = await host.conversations(created.id);
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0]!.id, "coding-session-1");
      assert.equal(conversations[0]!.projectId, created.id);
      assert.match(conversations[0]!.title, /WRITE_FILE/u);

      // A follow-up turn reuses the session; the first request stays the title.
      seenTools.length = 0;
      await host.request<{ model: string }>(
        "coding",
        {
          chatId: "coding-2",
          sessionId: "coding-session-1",
          projectId: created.id,
          prompt: "继续",
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        AbortSignal.timeout(150_000),
      );
      // The live agent keeps its allow-list on later turns, not only the first:
      // coding tools stay visible and excluded ones do not leak back in.
      const followUpTools = new Set(seenTools.flat());
      for (const expected of ["read", "write", "edit"])
        assert.ok(
          followUpTools.has(expected),
          `follow-up turn should expose ${expected}; saw ${[...followUpTools].join(", ")}`,
        );
      assert.ok(
        !followUpTools.has("ask_user_question"),
        `follow-up turn must keep the allow-list; saw ${[...followUpTools].join(", ")}`,
      );
      const afterFollowUp = await host.conversations(created.id);
      assert.equal(afterFollowUp.length, 1);
      assert.match(afterFollowUp[0]!.title, /WRITE_FILE/u);
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
        chatTools.has("aura_tts"),
        `ordinary chat should expose its workflow tools; saw ${[...chatTools].join(", ")}`,
      );
      for (const name of ["read", "write", "edit", "bash", "glob"])
        assert.ok(
          !chatTools.has(name),
          `ordinary chat must not expose ${name}; saw ${[...chatTools].join(", ")}`,
        );
    } finally {
      await host.close?.();
      model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
