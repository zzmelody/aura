import assert from "node:assert/strict";
import test from "node:test";
import { CodingQuestions } from "../src/coding/questions.ts";
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
