import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { codingSubagents } from "../src/conversations/subagents.ts";

type Inspection = Awaited<ReturnType<Context["sessionController"]["inspect"]>>;

function fixture(
  events: unknown[],
  options: {
    running?: boolean;
    unreadable?: boolean;
    unlabeled?: boolean;
  } = {},
) {
  let unreadable = options.unreadable;
  const ctx = {
    subagents: {
      listChildren: async () => [
        { id: "child", ...(options.unlabeled ? {} : { label: "调研插件" }) },
      ],
    },
    agents: {
      get: () => (options.running ? { status: "running" } : undefined),
    },
    sessionController: {
      inspect: async () => {
        if (unreadable) throw new Error("private-path synthetic-api-key");
        return {
          meta: { agentPreset: "coding-reviewer" },
          events,
        } as Inspection;
      },
    },
  } as unknown as Context;
  return {
    read: () => codingSubagents(ctx, "parent"),
    recover: () => {
      unreadable = false;
    },
  };
}

function start(turn = 1, time = 1000) {
  return { type: "turn/start", time, data: { turn } };
}
function answer(text: string, turn = 1, time = 2000) {
  return {
    type: "assistant/message",
    time,
    data: { turn, message: { content: [{ type: "text", text }] } },
  };
}
function end(kind: string, turn = 1, time = 3000) {
  return {
    type: "turn/end",
    time,
    data: {
      turn,
      reason: {
        kind,
        error: {
          message: "HTTP 503 private-path synthetic-api-key",
          code: "UNKNOWN",
        },
      },
    },
  };
}

test("execution errors and unreadable child records have separate outcomes and safe messages", async () => {
  const failed = (await fixture([start(), end("error")]).read())[0]!;
  assert.equal(failed.status, "error");
  assert.match(failed.executionError!, /HTTP 503/u);
  assert.deepEqual(failed.executionErrorDetails, {
    code: "model_http_failed",
    params: { status: 503 },
  });
  assert.equal(failed.roleKind, "review");
  assert.equal(failed.defaultLabel, undefined);
  assert.equal(failed.label, "调研插件");
  assert.equal(failed.recordError, undefined);
  assert.ok(!JSON.stringify(failed).includes("synthetic-api-key"));
  assert.ok(!JSON.stringify(failed).includes("private-path"));

  const source = fixture([start(), answer("done"), end("completed")], {
    unreadable: true,
  });
  const unreadable = (await source.read())[0]!;
  assert.equal(unreadable.status, "unknown");
  assert.ok(unreadable.recordError);
  assert.deepEqual(unreadable.recordErrorDetails, {
    code: "subagent_record_unavailable",
  });
  assert.equal(unreadable.executionError, undefined);
  assert.equal(unreadable.result, "");
  assert.ok(!JSON.stringify(unreadable).includes("synthetic-api-key"));
  source.recover();
  const recovered = (await source.read())[0]!;
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.result, "done");
  assert.equal(recovered.recordError, undefined);
  assert.equal(recovered.recordErrorDetails, undefined);
  assert.equal(recovered.durationMs, 2000);
  const [unnamed] = await fixture([], { unlabeled: true }).read();
  assert.equal(unnamed.defaultLabel, true);
  assert.equal(unnamed.label, "子 Agent");
});

test("a read failure preserves a live child's independently known running state", async () => {
  const child = (
    await fixture([], { unreadable: true, running: true }).read()
  )[0]!;
  assert.equal(child.status, "running");
  assert.ok(child.recordError);
  assert.equal(child.executionError, undefined);
});

test("forked parent results cannot establish a child's outcome or elapsed time", async () => {
  const inherited = [
    start(),
    answer("parent result"),
    end("completed"),
    { type: "subagent/descriptor", time: 4000, data: {} },
  ];
  const blank = (await fixture(inherited).read())[0]!;
  assert.equal(blank.status, "unknown");
  assert.equal(blank.result, "");
  assert.equal(blank.durationMs, undefined);
  const own = (
    await fixture([
      ...inherited,
      start(2, 5000),
      answer("child result", 2, 6000),
      end("completed", 2, 7000),
    ]).read()
  )[0]!;
  assert.equal(own.status, "complete");
  assert.equal(own.result, "child result");
  assert.equal(own.durationMs, 2000);
});

test("a later unfinished turn does not reuse an earlier completed result", async () => {
  const child = (
    await fixture([
      start(),
      answer("old result"),
      end("completed"),
      start(2, 4000),
      { type: "step/start", time: 4500, data: { turn: 2 } },
    ]).read()
  )[0]!;
  assert.equal(child.status, "stopped");
  assert.equal(child.result, "");
  assert.equal(child.durationMs, 2500);
});

test("output limits are execution failures while canceled turns stay stopped", async () => {
  const limited = (
    await fixture([start(), answer("partial result"), end("max-tokens")]).read()
  )[0]!;
  assert.equal(limited.status, "error");
  assert.match(limited.executionError!, /输出上限/u);
  assert.deepEqual(limited.executionErrorDetails, {
    code: "subagent_output_limit",
  });
  assert.equal(limited.result, "partial result");
  const stopped = (await fixture([start(), end("aborted")]).read())[0]!;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.executionError, undefined);
  assert.equal(stopped.recordError, undefined);
});
