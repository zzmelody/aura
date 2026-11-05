import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { startHonoServer, closeHonoServer } from "../src/http-server.ts";
import { createApiApp } from "../src/api-server.ts";
import { OrchestrationHost } from "../src/dsh/host.ts";
import type { CodexAuthPort } from "../src/types.ts";
import type {
  ConversationCommand,
  ConversationReceipt,
  ConversationSnapshot,
} from "@aura/protocol/conversation-channel";

const codexAuth: CodexAuthPort = {
  modelId: "fixture",
  async status() {
    return { state: "signed_out", model: "fixture" };
  },
  async startLogin(method) {
    return { state: "pending", method, model: "fixture" };
  },
  submitLoginInput() {
    return { state: "signed_out", model: "fixture" };
  },
  async cancelLogin() {
    return { state: "signed_out", model: "fixture" };
  },
};

test(
  "real DSH survives disconnected commands and legacy streams, replays events, and restores receipts without rerunning",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-channel-"));
    let host: OrchestrationHost | undefined;
    let api: Awaited<ReturnType<typeof startHonoServer>> | undefined;
    const resources: { model?: Awaited<ReturnType<typeof startHonoServer>> } =
      {};
    const release = new Map<number, () => void>();
    let calls = 0;
    let asking = false;
    t.after(async () => {
      for (const resolve of release.values()) resolve();
      if (api) await closeHonoServer(api.server);
      await host?.close();
      if (resources.model) await closeHonoServer(resources.model.server);
      await rm(root, { recursive: true, force: true });
    });
    const project = join(root, "project");
    const flowRoot = join(root, "flows");
    await mkdir(project);
    await mkdir(flowRoot);
    // Synthetic local model: holds each request until the test releases it.
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as {
        messages: Array<{ role: string; content: unknown }>;
        tools?: unknown[];
      };
      const title =
        !request.tools?.length &&
        JSON.stringify(request.messages).includes("为对话提炼");
      const call = title ? 0 : ++calls;
      const ask = asking && call === 3;
      return streamSSE(context, async (stream) => {
        if (!title && !ask)
          await new Promise<void>((resolve) => {
            release.set(call, resolve);
            stream.onAbort(resolve);
          });
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: ask
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "question-1",
                          type: "function",
                          function: {
                            name: "ask_user_question",
                            arguments: JSON.stringify({
                              questions: [
                                {
                                  id: "scope",
                                  question: "Continue?",
                                  options: [{ label: "Yes" }, { label: "No" }],
                                },
                              ],
                            }),
                          },
                        },
                      ],
                    }
                  : { content: title ? "检查任务状态" : `reply-${call}` },
                finish_reason: null,
              },
            ],
          }),
        });
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: ask ? "tool_calls" : "stop",
              },
            ],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
      });
    });
    const model = await startHonoServer(modelApp, "127.0.0.1", 0);
    resources.model = model;
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${model.port}/v1`,
    };
    host = new OrchestrationHost(options);
    const space = await host.createProject(project);
    api = await startHonoServer(
      createApiApp({ codexAuth, flows: host }),
      "127.0.0.1",
      0,
    );
    const endpoint = `http://127.0.0.1:${api.port}`;
    const id = "channel-session";
    const path = `${endpoint}/coding/sessions/${id}`;
    const command: ConversationCommand = {
      commandId: randomUUID(),
      type: "turn.start",
      input: {
        projectId: space.id,
        prompt: "check",
        mode: "demo",
        modelConfig: { model: "deepseek-v4-flash", reasoningEffort: "off" },
      },
    };
    const submit = async (value: ConversationCommand) => {
      const response = await fetch(`${path}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json() as Promise<ConversationReceipt>;
    };
    const snapshot = async () => {
      const response = await fetch(`${path}/snapshot`);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<ConversationSnapshot>;
    };
    const until = async (condition: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 200; i++) {
        if (await condition()) return;
        await delay(25);
      }
      assert.fail("condition did not become true");
    };
    assert.equal((await submit(command)).status, "accepted");
    await until(() => calls === 1);
    await submit(command);
    assert.equal(calls, 1);
    const before = await snapshot();
    assert.equal(before.running, true);
    const connection = new AbortController();
    const events = await fetch(`${path}/events`, { signal: connection.signal });
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: snapshot/u);
    connection.abort();
    await reader.cancel().catch(() => undefined);
    assert.equal((await snapshot()).running, true);
    release.get(1)!();
    await until(async () => !(await snapshot()).running);
    const complete = await snapshot();
    assert.equal(complete.execution?.status, "complete");
    assert.ok(
      complete.turns.some((turn) =>
        turn.events.some(
          (event) => event.type === "delta" && event.text.includes("reply-1"),
        ),
      ),
    );
    assert.ok(complete.turns[0]?.turnId);
    const replay = new AbortController();
    const resumed = await fetch(
      `${path}/events?cursor=${encodeURIComponent(before.cursor)}`,
      { signal: replay.signal },
    );
    const replayReader = resumed.body!.getReader();
    assert.match(
      new TextDecoder().decode((await replayReader.read()).value),
      /event: event/u,
    );
    replay.abort();
    await replayReader.cancel().catch(() => undefined);

    // The old streaming endpoint is also only an observer of the same service.
    const legacy = new AbortController();
    const old = await fetch(`${endpoint}/coding/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: legacy.signal,
      body: JSON.stringify({
        sessionId: id,
        projectId: space.id,
        prompt: "again",
        mode: "demo",
      }),
    });
    const oldReader = old.body!.getReader();
    await oldReader.read();
    legacy.abort();
    await oldReader.cancel().catch(() => undefined);
    await until(() => calls === 2);
    assert.equal((await snapshot()).running, true);
    const active = (await snapshot()).execution!;
    await submit({
      commandId: randomUUID(),
      type: "turn.stop",
      executionId: active.id,
    });
    await until(async () => !(await snapshot()).running);
    assert.equal((await snapshot()).execution?.status, "stopped");
    assert.equal(calls, 2);

    // A newly connected client can recover and answer an outstanding question.
    asking = true;
    const third = { ...command, commandId: randomUUID() };
    await submit(third);
    const pendingQuestion = async () =>
      (await snapshot()).turns
        .flatMap((turn) => turn.events)
        .find((event) => event.type === "question");
    await until(async () => Boolean(await pendingQuestion()));
    const question = await pendingQuestion();
    assert.ok(question?.type === "question");
    const answer: ConversationCommand = {
      commandId: randomUUID(),
      type: "question.answer",
      executionId: third.commandId,
      questionId: question.questionId,
      answers: [{ id: "scope", selected: ["Yes"] }],
    };
    const receipt = async (commandId: string) => {
      const response = await fetch(`${path}/commands/${commandId}`);
      assert.equal(response.status, 200);
      return response.json() as Promise<ConversationReceipt>;
    };
    await submit(answer);
    await until(() => calls === 4);
    await until(
      async () => (await receipt(answer.commandId)).status === "applied",
    );
    await submit(answer);
    const competing = {
      ...answer,
      commandId: randomUUID(),
      answers: [{ id: "scope", selected: ["No"] }],
    };
    await submit(competing);
    await until(
      async () => (await receipt(competing.commandId)).status === "rejected",
    );
    assert.equal(calls, 4, "answer retries must not continue the model twice");
    release.get(4)!();
    await until(async () => !(await snapshot()).running);

    await closeHonoServer(api.server);
    api = undefined;
    await host.close();
    host = new OrchestrationHost(options);
    const recovered = await host.request<ConversationReceipt>(
      "coding/commands",
      { sessionId: id, command },
    );
    assert.equal(recovered.execution?.status, "complete");
    assert.equal(
      calls,
      4,
      "recovered command must never issue another model request",
    );
  },
);
