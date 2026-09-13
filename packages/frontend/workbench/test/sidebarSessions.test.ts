import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@aura/core/types";
import {
  groupSidebarSessions,
  sidebarSessionTitle,
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
