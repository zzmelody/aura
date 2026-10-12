import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_ALLOW,
  APPROVAL_REJECT,
  approvalAnswer,
  approvalOutcome,
  approvalQuestion,
  CodingQuestions,
  codingQuestions,
} from "../src/coding/questions.ts";
import type { CodingQuestion } from "../src/types.ts";

const asked: CodingQuestion[] = [
  {
    id: "mode",
    question: "用哪种方式？",
    options: [{ label: "A" }, { label: "B" }],
  },
  {
    id: "extras",
    question: "还要哪些？",
    options: [{ label: "x" }, { label: "y" }],
    multiSelect: true,
  },
];

function start(store: CodingQuestions, signal = new AbortController().signal) {
  let questionId = "";
  const answered = store.ask("s1", asked, signal, (id) => {
    questionId = id;
  });
  return { answered, questionId: () => questionId };
}

test("an answer resolves the waiting question with only offered options", async () => {
  const store = new CodingQuestions();
  const { answered, questionId } = start(store);
  assert.equal(store.open("s1").length, 1);
  store.answer("s1", questionId(), [
    { id: "mode", selected: ["A", "B", "invented"] },
    { id: "extras", selected: ["x", "y", "z"] },
    { id: "unknown", selected: ["A"] },
  ]);
  assert.deepEqual(await answered, [
    { id: "mode", selected: ["A"] },
    { id: "extras", selected: ["x", "y"] },
  ]);
  assert.equal(store.open("s1").length, 0);
});

test("typed text replaces a single choice and a skipped question stays empty", async () => {
  const store = new CodingQuestions();
  const { answered, questionId } = start(store);
  store.answer("s1", questionId(), [
    { id: "mode", selected: ["A"], custom: "  都不要，用 C  " },
  ]);
  assert.deepEqual(await answered, [
    { id: "mode", selected: [], custom: "都不要，用 C" },
    { id: "extras", selected: [] },
  ]);
});

test("another session cannot answer, and an answered question cannot be reused", async () => {
  const store = new CodingQuestions();
  const { answered, questionId } = start(store);
  assert.throws(() => store.answer("s2", questionId(), []), { status: 404 });
  store.answer("s1", questionId(), []);
  await answered;
  assert.throws(() => store.answer("s1", questionId(), []), { status: 404 });
  assert.throws(() => store.answer("s1", "nope", []), { status: 404 });
});

test("a malformed answer is rejected and leaves the question open", () => {
  const store = new CodingQuestions();
  const { questionId } = start(store);
  assert.throws(() => store.answer("s1", questionId(), "not a list"), {
    status: 400,
  });
  assert.equal(store.open("s1").length, 1);
});

test("stopping the turn rejects the wait and clears the question", async () => {
  const store = new CodingQuestions();
  const stop = new AbortController();
  const { answered } = start(store, stop.signal);
  stop.abort(new Error("stopped"));
  await assert.rejects(answered, /stopped/u);
  assert.equal(store.open("s1").length, 0);
});

test("an approval card grants only on an explicit allow and ignores typed text", async () => {
  const store = new CodingQuestions();
  const card = approvalQuestion(
    "bash",
    "escalate sandbox to danger-full-access: 需要装依赖",
  );
  assert.equal(card.kind, "approval");
  assert.deepEqual(
    card.options?.map((option) => option.label),
    [APPROVAL_ALLOW, APPROVAL_REJECT],
  );
  let questionId = "";
  const answered = store.ask(
    "s1",
    [card],
    new AbortController().signal,
    (id) => {
      questionId = id;
    },
  );
  // Free text cannot turn a refusal into a grant.
  store.answer("s1", questionId, [
    { id: card.id, selected: [], custom: APPROVAL_ALLOW },
  ]);
  const answers = await answered;
  assert.deepEqual(answers, [{ id: card.id, selected: [] }]);
  assert.equal(approvalOutcome(answers), "rejected");
  assert.equal(
    approvalOutcome([{ id: card.id, selected: [APPROVAL_ALLOW] }]),
    "allowed-once",
  );
  assert.equal(approvalOutcome([]), "rejected");
});

test("logged approval outcomes map back to card answers", () => {
  assert.deepEqual(approvalAnswer("allowed-once")?.selected, [APPROVAL_ALLOW]);
  assert.deepEqual(approvalAnswer("rejected")?.selected, [APPROVAL_REJECT]);
  assert.equal(approvalAnswer("cancelled")?.custom, "已取消");
  // Nobody saw an unavailable approval, so it has no card.
  assert.equal(approvalAnswer("unavailable"), undefined);
});

test("a plan-review intent survives only when it names an offered option", () => {
  const [kept, dropped] = codingQuestions([
    {
      id: "plan",
      question: "批准这个计划吗？",
      detail: "# 计划",
      options: [{ label: "批准" }, { label: "修改" }],
      intent: { kind: "plan-review", approve: "批准" },
    },
    {
      id: "plan2",
      question: "批准吗？",
      options: [{ label: "好" }],
      intent: { kind: "plan-review", approve: "不存在" },
    },
  ]);
  assert.deepEqual(kept!.intent, { kind: "plan-review", approve: "批准" });
  assert.equal(dropped!.intent, undefined);
});

test("a sandbox escalation reason is shown in plain language", () => {
  const card = approvalQuestion(
    "bash",
    "escalate sandbox to danger-full-access: 测试需要访问网络",
  );
  assert.equal(card.header, undefined);
  assert.equal(
    card.detail,
    "请求把沙箱放宽到「完全访问（不受沙箱限制）」。理由：测试需要访问网络",
  );
  // Any other reason is shown as given.
  assert.equal(approvalQuestion("write", "hook 拦截").detail, "hook 拦截");
});
