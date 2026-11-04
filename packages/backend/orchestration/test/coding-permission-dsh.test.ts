import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/index.ts";
import type { CodingPermission } from "@aura/protocol/types";
import type { CodingStreamEvent } from "../src/types.ts";

test(
  "a running side chat follows permission changes through DSH and after restart",
  {
    timeout: 180_000,
    skip:
      Number(process.versions.node.split(".")[0]) < 24
        ? "DSH requires Node >=24"
        : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-coding-permission-"));
    const project = join(root, "project");
    const flowRoot = join(root, "flow");
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const policies: string[] = [];
    let host: OrchestrationHost | undefined;
    let model: ServerType | undefined;
    t.after(async () => {
      release.resolve();
      await host?.close();
      model?.close();
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(project);
    await mkdir(flowRoot);

    // Local synthetic model. Only DSH executes the shell command.
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = await context.req.json<{
        messages: Array<{ role: string; content: unknown }>;
      }>();
      const policy = request.messages
        .map(({ content }) => JSON.stringify(content) ?? "")
        .findLast((content) => content.includes("Current DSH file policy:"));
      if (policy) policies.push(policy);
      const at = request.messages.findLastIndex(({ role }) => role === "user");
      const prompt = JSON.stringify(request.messages[at]?.content) ?? "";
      const marker = /WRITE_(LIVE|RESTORED)/u.exec(prompt)?.[1]?.toLowerCase();
      const call =
        !!marker &&
        !request.messages.slice(at + 1).some(({ role }) => role === "tool");
      if (call && marker === "live") {
        waiting.resolve();
        await release.promise;
      }
      const file = join(root, `${marker}.txt`);
      const windows = process.platform === "win32";
      const quoted = file.replaceAll("'", windows ? "''" : "'\"'\"'");
      const command = windows
        ? `Set-Content -LiteralPath '${quoted}' -Value permission-marker`
        : `printf permission-marker > '${quoted}'`;
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
                          id: `write_${marker}`,
                          type: "function",
                          function: {
                            name: windows ? "pwsh" : "bash",
                            arguments: JSON.stringify({
                              command,
                              description: "Write a temporary marker",
                            }),
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
    const events: CodingStreamEvent[] = [];
    const turn = (
      driver: OrchestrationHost,
      sessionId: string,
      prompt: string,
      forkFrom?: string,
      permission?: CodingPermission,
    ) =>
      driver.coding(
        {
          sessionId,
          projectId,
          prompt,
          forkFrom,
          permission,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
        },
        (event) => events.push(event),
        AbortSignal.timeout(45_000),
      );

    await turn(host, "main", "Start in read only", undefined, "read-only");
    const { sessionId: side } = await host.openCodingSide("main");
    const running = turn(host, side, "WRITE_LIVE", "main");
    try {
      await Promise.race([
        waiting.promise,
        running.then(() =>
          assert.fail("The side turn ended before reaching the tool call"),
        ),
      ]);
      assert.match(
        policies.at(-1) ?? "",
        /Current DSH file policy: read-only/u,
      );
      await host.selectConversationPermission("main", "danger-full-access");
    } finally {
      release.resolve();
    }
    await running;
    assert.equal(
      (await readFile(join(root, "live.txt"), "utf8")).trim(),
      "permission-marker",
    );
    assert.ok(!events.some((event) => event.type === "question"));

    await host.close();
    host = new OrchestrationHost(options);
    const [main] = await host.conversations(projectId, false);
    assert.equal(main?.permission, "danger-full-access");
    assert.equal(main?.sideConversations?.[0]?.permission, undefined);
    await turn(host, side, "WRITE_RESTORED", "main");
    assert.match(
      policies.at(-1) ?? "",
      /Current DSH file policy: danger-full-access/u,
    );
    assert.equal(
      (await readFile(join(root, "restored.txt"), "utf8")).trim(),
      "permission-marker",
    );
    assert.ok(!events.some((event) => event.type === "question"));
  },
);
