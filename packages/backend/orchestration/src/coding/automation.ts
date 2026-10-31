import type { Context } from "@deepseek-ai/cordis";
import {
  ScheduleId,
  ScheduleInputError,
  type ScheduleCatalogEntry,
  type ScheduleCreateRequest,
  type ScheduleRecord,
  type ScheduleTimingChange,
} from "@deepseek-ai/dsh-schedule";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {
  AutomationHistory,
  AutomationTask,
  AutomationTaskInput,
  AutomationTiming,
  AutomationTimingInput,
} from "@aura/protocol/types";
import { FlowError } from "../schema.ts";
import type { CodingConversationIndex } from "./index-record.ts";

/** Deliveries returned per history read; DSH caps a page at 100. */
const HISTORY_LIMIT = 50;

/**
 * Automation tasks are DSH Schedule reminders bound to Aura coding
 * conversations. DSH owns storage, timing and delivery; this adapter only
 * limits the catalog to coding sessions and maps records to Aura's shape.
 */
export function automationService(
  ctx: Context,
  conversations: CodingConversationIndex,
) {
  return { list, create, update, remove, history };

  async function list(): Promise<AutomationTask[]> {
    return (await ctx.schedule.catalog()).flatMap((entry) => {
      const owner = conversations.get(entry.sessionId);
      return owner ? [task(entry, owner.projectId, owner.title)] : [];
    });
  }

  async function create(input: AutomationTaskInput): Promise<AutomationTask> {
    const owner = conversation(input.sessionId);
    const record = await guard(() =>
      ctx.schedule.create(SessionId(input.sessionId), {
        title: input.title,
        prompt: input.prompt,
        ...selector(input.timing),
      }),
    );
    return task(
      { ...record, sessionId: SessionId(input.sessionId), status: "active" },
      owner.projectId,
      owner.title,
    );
  }

  async function update(
    id: string,
    input: AutomationTaskInput,
  ): Promise<AutomationTask> {
    const owner = conversation(input.sessionId);
    const sessionId = SessionId(input.sessionId);
    const expected = (await ctx.schedule.list({ sessionId })).find(
      (record) => record.id === id,
    );
    if (!expected) throw new FlowError("任务不存在或已结束。", 404);
    const result = await guard(() =>
      ctx.schedule.update({
        sessionId,
        id: ScheduleId(id),
        expected,
        title: input.title,
        prompt: input.prompt,
        change: change(input.timing),
      }),
    );
    if ("code" in result)
      throw new FlowError(
        result.code === "schedule_conflict"
          ? "任务刚刚被修改或已执行，请刷新后重试。"
          : "任务不存在或已结束。",
        result.code === "schedule_conflict" ? 409 : 404,
      );
    return task(
      { ...result.record, sessionId, status: "active" },
      owner.projectId,
      owner.title,
    );
  }

  async function remove(sessionId: string, id: string): Promise<boolean> {
    conversation(sessionId);
    const result = await ctx.schedule.delete({
      sessionId: SessionId(sessionId),
      id: ScheduleId(id),
    });
    return result.deleted;
  }

  async function history(
    sessionId: string,
    id: string,
  ): Promise<AutomationHistory> {
    conversation(sessionId);
    const result = await ctx.schedule.history({
      sessionId: SessionId(sessionId),
      id: ScheduleId(id),
      limit: HISTORY_LIMIT,
    });
    if (!("records" in result)) throw new FlowError("任务不存在。", 404);
    return {
      records: result.records.map(({ scheduledAt, deliveredAt, prompt }) => ({
        scheduledAt,
        deliveredAt,
        ...(prompt === undefined ? {} : { prompt }),
      })),
      truncated:
        result.nextBefore !== undefined ||
        result.earlierRecordsUnavailable ||
        result.earlierRecordsPruned,
    };
  }

  /** Only coding conversations take tasks; other DSH sessions stay private. */
  function conversation(sessionId: string) {
    const owner = conversations.get(sessionId);
    if (!owner || owner.archivedAt !== undefined)
      throw new FlowError("对话不存在或已归档。", 404);
    return owner;
  }
}

/** DSH validation errors carry user-actionable messages; others stay generic. */
async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ScheduleInputError)
      throw new FlowError(scheduleInputMessage(error.code), 400);
    throw error;
  }
}

function scheduleInputMessage(code: ScheduleInputError["code"]): string {
  switch (code) {
    case "invalid_prompt":
      return "请填写任务名称（最多 120 字）和指令。";
    case "invalid_rule":
      return "运行时间规则无效，请检查 cron 表达式或星期。";
    case "invalid_time_zone":
      return "时区无效。";
    case "not_future":
      return "运行时间必须晚于现在。";
    case "time_out_of_range":
      return "运行时间超出支持范围。";
    case "frequency_too_high":
      return "运行间隔不能少于 1 分钟。";
    case "subagent_session":
      return "子代理会话不能设置自动化任务。";
    case "invalid_selector":
      return "请选择一种运行时间。";
  }
}

function selector(
  timing: AutomationTimingInput,
): Omit<ScheduleCreateRequest, "title" | "prompt"> {
  switch (timing.kind) {
    case "at":
      return { at: timing.at };
    case "every":
      return { every_seconds: timing.everySeconds };
    case "daily":
      return { daily: { time: timing.time, time_zone: timing.timeZone } };
    case "weekly":
      return {
        weekly: {
          time: timing.time,
          time_zone: timing.timeZone,
          weekdays: timing.weekdays,
        },
      };
    case "cron":
      return {
        cron: { expression: timing.expression, time_zone: timing.timeZone },
      };
  }
}

function change(timing: AutomationTimingInput): ScheduleTimingChange {
  switch (timing.kind) {
    case "at":
      return { kind: "at", at: timing.at };
    case "every":
      return { kind: "every", every_seconds: timing.everySeconds };
    case "daily":
      return {
        kind: "daily",
        daily: { time: timing.time, time_zone: timing.timeZone },
      };
    case "weekly":
      return {
        kind: "weekly",
        weekly: {
          time: timing.time,
          time_zone: timing.timeZone,
          weekdays: timing.weekdays,
        },
      };
    case "cron":
      return {
        kind: "cron",
        cron: { expression: timing.expression, time_zone: timing.timeZone },
      };
  }
}

function timingOf(record: ScheduleRecord): AutomationTiming {
  switch (record.kind) {
    case "at":
      return { kind: "at", at: record.scheduledAt };
    case "after":
      return { kind: "after", afterSeconds: record.afterSeconds };
    case "every":
      return { kind: "every", everySeconds: record.everySeconds };
    case "daily":
      return { kind: "daily", time: record.time, timeZone: record.timeZone };
    case "weekly":
      return {
        kind: "weekly",
        time: record.time,
        timeZone: record.timeZone,
        weekdays: record.weekdays,
      };
    case "cron":
      return {
        kind: "cron",
        expression: record.expression,
        timeZone: record.timeZone,
      };
  }
}

export function task(
  entry: ScheduleCatalogEntry,
  projectId: string,
  conversationTitle: string,
): AutomationTask {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    projectId,
    conversationTitle,
    title: entry.title,
    prompt: entry.prompt,
    timing: timingOf(entry),
    scheduledAt: entry.scheduledAt,
    status: entry.status === "active" ? "active" : "ended",
    ...(entry.lastDelivery
      ? { lastDeliveredAt: entry.lastDelivery.deliveredAt }
      : {}),
  };
}
