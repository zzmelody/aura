import assert from "node:assert/strict";
import test from "node:test";
import { PERSONAL_ASSISTANT_SESSION_ID } from "@aura/protocol/conversations";
import { conversationService } from "../src/conversations/conversations.ts";
import {
  CodingConversationIndex,
  type CodingConversationRecord,
} from "../src/conversations/index-record.ts";
import type { ConversationTitleGenerator } from "../src/conversations/conversation-title.ts";
import type { CodingStreamEvent, Table } from "../src/types.ts";

function fixture(generate: ConversationTitleGenerator) {
  const records = new Map<string, CodingConversationRecord>();
  const table: Table<CodingConversationRecord> = {
    get: (id) => records.get(id),
    entries: () => records.entries(),
    async put(id, value) {
      records.set(id, structuredClone(value));
    },
    async delete(id) {
      return records.delete(id);
    },
    async update(id, change) {
      const current = records.get(id);
      assert.ok(current);
      const next = change(structuredClone(current));
      records.set(id, next);
      return structuredClone(next);
    },
  };
  const index = new CodingConversationIndex(table);
  const events: CodingStreamEvent[] = [];
  const titles: string[] = [];
  const service = conversationService(
    {
      list: () => [],
      defaultProject: async () => ({
        id: "project",
        directory: "/fixture",
        title: "Fixture",
      }),
      directory: () => "/fixture",
      attach: async () => {},
    },
    index,
    {
      async stream(request) {
        if (request.prompt === "FAIL") throw new Error("reply failed");
        events.push({ type: "delta", text: "reply" });
        return { model: "selected" };
      },
      applyPermission() {},
    },
    async (request, signal) => {
      assert.equal(
        events.at(-1)?.type,
        "delta",
        "the main reply finishes before titling",
      );
      titles.push(request.sessionId);
      return generate(request, signal);
    },
  );
  const send = (
    id: string,
    prompt = "请帮我修复侧边对话里看不到引用文字的问题",
    forkFrom?: string,
    signal = new AbortController().signal,
  ) =>
    service.stream(
      { sessionId: id, prompt, mode: "demo", model: "selected", forkFrom },
      (event) => events.push(event),
      signal,
    );
  return { index, send, titles, events, table };
}

test("first replies summarize main and side titles once and retain them after index reload", async () => {
  const { index, send, titles, table } = fixture(async (request) => {
    assert.equal(request.model, "selected");
    return request.forkFrom ? "侧边引用排错" : "修复侧边引用显示";
  });
  await send("main");
  assert.equal(index.get("main")?.title, "修复侧边引用显示");
  const side = await index.openSide("main");
  await send(side, "选中的引用消失了", "main");
  await send("main", "继续");
  await send(side, "再确认一下", "main");
  const reloaded = new CodingConversationIndex(table);
  assert.equal(reloaded.get("main")?.title, "修复侧边引用显示");
  assert.equal(
    reloaded.get("main")?.sideConversations?.[0]?.title,
    "侧边引用排错",
  );
  assert.deepEqual(titles, ["main", side]);
});

test("title failures preserve a successful reply and are never retried by later turns", async () => {
  const { index, send, titles, events } = fixture(async () => {
    throw new Error("sensitive upstream error");
  });
  assert.deepEqual(await send("main", "原始任务"), { model: "selected" });
  assert.equal(index.get("main")?.title, "原始任务");
  await send("main", "后续问题");
  assert.deepEqual(titles, ["main"]);
  const notices = events.filter((event) => event.type === "notice");
  assert.equal(notices.length, 1);
  assert.doesNotMatch(JSON.stringify(notices), /sensitive upstream/u);
  assert.match(JSON.stringify(notices), /已保留临时标题/u);
});

test("failed replies, empty prompts, restored chats and Aura do not request a title", async () => {
  const { index, send, titles } = fixture(async () => "unexpected title");
  await assert.rejects(send("failed", "FAIL"), /reply failed/u);
  await send("failed", "用户重新发送");
  await send("images", "");
  await index.open("restored", "project", "已有标题");
  await send("restored");
  await index.openAssistant("project");
  await send(PERSONAL_ASSISTANT_SESSION_ID);
  assert.deepEqual(titles, []);
  assert.equal(index.get("restored")?.title, "已有标题");
  assert.equal(index.getAssistant()?.title, "Aura");
});

test("late titles cannot overwrite a renamed or archived chat or resurrect a closed side", async () => {
  let finish: ((title: string) => void) | undefined;
  let started: (() => void) | undefined;
  const ready = () =>
    new Promise<void>((resolve) => {
      started = resolve;
    });
  const { index, send } = fixture(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
        started?.();
      }),
  );
  let waiting = ready();
  let sending = send("renamed");
  await waiting;
  await index.touch("renamed", { title: "用户命名" });
  finish!("迟到的标题");
  await sending;
  assert.equal(index.get("renamed")?.title, "用户命名");

  waiting = ready();
  sending = send("archived");
  await waiting;
  const original = index.get("archived")?.title;
  await index.archive("archived", true);
  finish!("迟到的标题");
  await sending;
  assert.equal(index.get("archived")?.title, original);

  const side = await index.openSide("renamed");
  waiting = ready();
  sending = send(side, "侧边问题", "renamed");
  await waiting;
  await index.closeSide(side);
  finish!("迟到的侧边标题");
  await sending;
  assert.equal(index.sideParent(side), undefined);
  assert.equal(index.get("renamed")?.sideConversations, undefined);
});

test("cancelling title generation keeps the provisional title and successful transcript", async () => {
  const abort = new AbortController();
  const { index, send, titles, events } = fixture(async (_request, signal) => {
    abort.abort(new Error("stopped"));
    signal.throwIfAborted();
    return "unexpected";
  });
  assert.deepEqual(
    await send("main", "保留这个标题", undefined, abort.signal),
    { model: "selected" },
  );
  assert.equal(index.get("main")?.title, "保留这个标题");
  assert.deepEqual(titles, ["main"]);
  assert.equal(
    events.some((event) => event.type === "delta"),
    true,
  );
  assert.equal(
    events.some((event) => event.type === "notice"),
    false,
  );
});
