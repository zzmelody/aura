import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@aura/core/types";
import {
  groupSidebarSessions,
  sidebarRowStatus,
  sidebarSessionTitle,
  sidebarSessionStatus,
  sidebarSessionTime,
} from "../src/sidebarSessions.ts";

const session: Session = {
  id: "one",
  title: "Research",
  updatedAt: 1,
  messages: [
    {
      id: "input",
      role: "user",
      status: "complete",
      text: "Compare options\nfor launch",
    },
  ],
  workflow: {
    id: "research",
    title: "Research",
    endpoint: "http://localhost:4311",
  },
};
test("sidebar time stays compact at unit boundaries and tolerates future clocks", () => {
  const now = Date.UTC(2026, 9, 3);
  const ago = (seconds: number) =>
    sidebarSessionTime(now - seconds * 1000, now);
  assert.equal(ago(0), "刚刚");
  assert.equal(ago(59), "刚刚");
  assert.equal(ago(60), "1分钟");
  assert.equal(ago(3599), "59分钟");
  assert.equal(ago(3600), "1小时");
  assert.equal(ago(86400), "1天");
  assert.equal(ago(30 * 86400), "1个月");
  assert.equal(ago(365 * 86400), "1年");
  assert.equal(ago(-60), "刚刚");
  assert.equal(sidebarSessionTime(Number.NaN, now), "—");
});
test("a row shows a status icon only when it needs notice, otherwise its time", () => {
  assert.equal(sidebarRowStatus(undefined), undefined);
  assert.equal(
    sidebarRowStatus({ kind: "completed", label: "已完成" }),
    undefined,
  );
  assert.equal(
    sidebarRowStatus({ kind: "idle", label: "尚未开始" }),
    undefined,
  );
  // A turn the user stopped is settled, so the row shows its time.
  assert.equal(
    sidebarRowStatus({ kind: "stopped", label: "已停止" }),
    undefined,
  );
  for (const kind of ["running", "waiting", "failed", "attention"] as const)
    assert.equal(sidebarRowStatus({ kind, label: kind })?.kind, kind);
});
test("workflow rows identify their task while preserving custom conversation names", () => {
  assert.equal(sidebarSessionTitle(session), "Compare options for launch");
  assert.equal(
    sidebarSessionTitle({ ...session, title: "Custom name" }),
    "Custom name",
  );
  assert.equal(sidebarSessionTitle({ ...session, messages: [] }), "新的运行");
  assert.equal(
    sidebarSessionTitle({
      ...session,
      messages: [
        { ...session.messages[0], text: '{"task":"Compare alternatives"}' },
      ],
    }),
    "Compare alternatives",
  );
});
test("sidebar groups share workflow bindings without mixing endpoints or ordinary chats", () => {
  const groups = groupSidebarSessions([
    session,
    { ...session, id: "two" },
    {
      ...session,
      id: "remote",
      workflow: { ...session.workflow!, endpoint: "https://example.com" },
    },
    { ...session, id: "chat", workflow: undefined },
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups[0].sessions.map((item) => item.id),
    ["one", "two"],
  );
  assert.equal(groups[2].workflow, false);
});

test("sidebar distinguishes Flow waits, pauses, failures and ordinary chat states", () => {
  const state = (
    phase: NonNullable<Session["messages"][number]["workflowPhase"]>,
  ) =>
    sidebarSessionStatus({
      ...session,
      messages: [
        ...session.messages,
        {
          id: "output",
          role: "assistant",
          text: "",
          status: "complete",
          workflowRunId: "run",
          workflowPhase: phase,
        },
      ],
    });
  assert.deepEqual(state("queued"), { kind: "queued", label: "等待执行" });
  assert.equal(state("running").kind, "running");
  assert.equal(state("waiting_input").label, "等待输入");
  assert.equal(state("needs_attention").kind, "attention");
  assert.equal(state("paused").kind, "paused");
  assert.equal(state("failed").kind, "failed");
  assert.equal(state("completed").kind, "completed");
  assert.equal(state("cancelled").kind, "stopped");
  assert.equal(state("interrupted").label, "已中断");
  const chat = {
    ...session,
    workflow: undefined,
    messages: [
      {
        id: "reply",
        role: "assistant" as const,
        text: "",
        status: "streaming" as const,
      },
    ],
  };
  assert.deepEqual(sidebarSessionStatus(chat), {
    kind: "running",
    label: "正在生成",
  });
  assert.equal(
    sidebarSessionStatus({ ...chat, archivedAt: 1 }).kind,
    "running",
  );
  assert.equal(
    sidebarSessionStatus({
      ...chat,
      messages: [{ ...chat.messages[0], status: "error" }],
    }).kind,
    "failed",
  );
  assert.equal(
    sidebarSessionStatus({
      ...chat,
      messages: [{ ...chat.messages[0], status: "stopped" }],
    }).kind,
    "stopped",
  );
});
