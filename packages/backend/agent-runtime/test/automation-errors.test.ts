import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { ScheduleInputError } from "@deepseek-ai/dsh-schedule";
import { CodedFlowError, flowErrorBody } from "@aura/protocol/errors";
import { automationService } from "../src/conversations/automation.ts";
import type { CodingConversationIndex } from "../src/conversations/index-record.ts";

test("schedule validation and conflicts preserve safe codes without changing task input or retrying operations", async () => {
  let failure: ScheduleInputError | undefined;
  let calls = 0;
  let conflict = true;
  const inputs: unknown[] = [];
  const ctx = {
    schedule: {
      async create(_session: unknown, input: unknown) {
        calls++;
        inputs.push(structuredClone(input));
        throw failure;
      },
      async list() {
        return [{ id: "task" }];
      },
      async update() {
        calls++;
        return { code: conflict ? "schedule_conflict" : "schedule_not_found" };
      },
    },
  } as unknown as Context;
  const index = {
    get: () => ({ projectId: "workspace", title: "原始标题" }),
  } as unknown as CodingConversationIndex;
  const service = automationService(ctx, index);
  const input = {
    sessionId: "session",
    title: "原始任务",
    prompt: "Original instructions",
    timing: {
      kind: "daily" as const,
      time: "09:00",
      timeZone: "Asia/Shanghai",
    },
  };
  const original = structuredClone(input);
  for (const code of [
    "invalid_prompt",
    "invalid_rule",
    "invalid_time_zone",
    "not_future",
    "time_out_of_range",
    "frequency_too_high",
    "subagent_session",
    "invalid_selector",
  ] as const) {
    failure = new ScheduleInputError(
      code,
      "private implementation diagnostic",
      { cause: new Error("private cause") },
    );
    await assert.rejects(service.create(input), (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, 400);
      assert.equal(flowErrorBody(error).code, `automation_${code}`);
      assert.equal(
        JSON.stringify(flowErrorBody(error)).includes("private"),
        false,
      );
      return true;
    });
  }
  assert.equal(calls, 8);
  assert.deepEqual(input, original);
  assert.ok(
    inputs.every(
      (value) =>
        JSON.stringify(value) ===
        JSON.stringify({
          title: input.title,
          prompt: input.prompt,
          daily: { time: "09:00", time_zone: "Asia/Shanghai" },
        }),
    ),
  );
  for (const [exists, code, status] of [
    [true, "automation_conflict", 409],
    [false, "automation_missing", 404],
  ] as const) {
    conflict = exists;
    await assert.rejects(service.update("task", input), (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, status);
      assert.equal(flowErrorBody(error).code, code);
      return true;
    });
  }
  assert.equal(calls, 10);
});
