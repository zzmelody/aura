import { randomUUID } from "node:crypto";
import { FlowError } from "../schema.ts";
import type { CodingQuestion, CodingQuestionAnswer } from "../types.ts";

/** Upper bounds on what a client may send back for one question. */
const MAX_SELECTED = 20;
const MAX_TEXT = 4_000;

interface Pending {
  sessionId: string;
  questions: CodingQuestion[];
  resolve(answers: CodingQuestionAnswer[]): void;
}

/**
 * Questions a coding agent is waiting on. The agent's `ask_user_question`
 * call stays pending until the user answers through the coding routes, the
 * turn is stopped, or the agent itself cancels the call.
 *
 * An answer is accepted only for the session that asked and only for the
 * question ids that were asked, so one conversation cannot answer another's
 * question and a client cannot invent answers the model never requested.
 */
export class CodingQuestions {
  private readonly pending = new Map<string, Pending>();

  /** Registers a question and waits for its answer or for `signal`. */
  ask(
    sessionId: string,
    questions: CodingQuestion[],
    signal: AbortSignal,
    announce: (questionId: string) => void,
  ): Promise<CodingQuestionAnswer[]> {
    signal.throwIfAborted();
    const questionId = randomUUID();
    return new Promise<CodingQuestionAnswer[]>((resolve, reject) => {
      const settle = () => {
        this.pending.delete(questionId);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        settle();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(questionId, {
        sessionId,
        questions,
        resolve: (answers) => {
          settle();
          resolve(answers);
        },
      });
      announce(questionId);
    });
  }

  /** Delivers the user's answer; validates it against what was asked. */
  answer(sessionId: string, questionId: string, value: unknown): void {
    const pending = this.pending.get(questionId);
    if (!pending || pending.sessionId !== sessionId)
      throw new FlowError("这个问题已经结束或不存在。", 404);
    pending.resolve(validAnswers(pending.questions, value));
  }

  /** Questions still open in a session, for a client that reconnects. */
  open(
    sessionId: string,
  ): Array<{ questionId: string; questions: CodingQuestion[] }> {
    return [...this.pending]
      .filter(([, item]) => item.sessionId === sessionId)
      .map(([questionId, item]) => ({ questionId, questions: item.questions }));
  }
}

/**
 * Keeps one answer per asked question. A single-select question takes at most
 * one option; selected labels must be offered options; free text is clipped.
 * A question the user skipped is answered with an empty selection, which is
 * the shape DSH's own answerers use.
 */
function validAnswers(
  questions: CodingQuestion[],
  value: unknown,
): CodingQuestionAnswer[] {
  if (!Array.isArray(value)) throw new FlowError("无效的回答。", 400);
  const given = new Map<string, Record<string, unknown>>();
  for (const item of value)
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string"
    )
      given.set((item as { id: string }).id, item as Record<string, unknown>);
  return questions.map((question) => {
    const item = given.get(question.id);
    const labels = new Set((question.options ?? []).map((o) => o.label));
    const selected = Array.isArray(item?.selected)
      ? item.selected
          .filter(
            (label): label is string =>
              typeof label === "string" && labels.has(label),
          )
          .slice(0, question.multiSelect ? MAX_SELECTED : 1)
      : [];
    // An approval is a yes/no decision; typed text cannot stand in for it.
    const custom =
      question.kind !== "approval" &&
      typeof item?.custom === "string" &&
      item.custom.trim()
        ? item.custom.trim().slice(0, MAX_TEXT)
        : undefined;
    // For a single-select question, typed text replaces the chosen option.
    return {
      id: question.id,
      selected: custom && !question.multiSelect ? [] : selected,
      ...(custom ? { custom } : {}),
    };
  });
}

/** Option labels of an approval card; the first is the one-shot grant. */
export const APPROVAL_ALLOW = "允许这一次";
export const APPROVAL_REJECT = "拒绝";
export const APPROVAL_QUESTION_ID = "approval";

/**
 * An approval request as a question card: DSH asks before an operation that
 * needs consent (for example a command retried outside the sandbox), and the
 * user grants it once or refuses. Typed answers are not offered.
 */
export function approvalQuestion(
  toolName: string,
  reason?: string,
): CodingQuestion {
  return {
    id: APPROVAL_QUESTION_ID,
    kind: "approval",
    header: "需要你授权",
    question: `允许 ${toolName} 执行这个操作吗？`,
    ...(reason ? { detail: reason } : {}),
    options: [{ label: APPROVAL_ALLOW }, { label: APPROVAL_REJECT }],
  };
}

/** Only an explicit grant allows; a skipped or refused card rejects. */
export function approvalOutcome(
  answers: readonly CodingQuestionAnswer[],
): "allowed-once" | "rejected" {
  return answers.some((answer) => answer.selected.includes(APPROVAL_ALLOW))
    ? "allowed-once"
    : "rejected";
}

/** The card answer that a logged approval outcome corresponds to. */
export function approvalAnswer(
  outcome: string,
): CodingQuestionAnswer | undefined {
  if (outcome === "allowed-once")
    return { id: APPROVAL_QUESTION_ID, selected: [APPROVAL_ALLOW] };
  if (outcome === "rejected")
    return { id: APPROVAL_QUESTION_ID, selected: [APPROVAL_REJECT] };
  if (outcome === "cancelled")
    return { id: APPROVAL_QUESTION_ID, selected: [], custom: "已取消" };
  return undefined;
}

/** Narrows DSH's question items to what Aura forwards to the client. */
export function codingQuestions(items: readonly unknown[]): CodingQuestion[] {
  return items.flatMap((raw) => {
    const item = raw as Partial<Record<keyof CodingQuestion, unknown>> | null;
    if (typeof item?.id !== "string" || typeof item.question !== "string")
      return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          const value = option as { label?: unknown; description?: unknown };
          return typeof value?.label === "string"
            ? [
                {
                  label: value.label,
                  ...(typeof value.description === "string"
                    ? { description: value.description }
                    : {}),
                },
              ]
            : [];
        })
      : [];
    return [
      {
        id: item.id,
        question: item.question,
        ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
        ...(typeof item.header === "string" ? { header: item.header } : {}),
        ...(options.length ? { options } : {}),
        ...(item.multiSelect === true ? { multiSelect: true } : {}),
        ...planReview(item.intent, options),
      },
    ];
  });
}

/**
 * Keeps a `plan-review` intent only when its approving label is one of the
 * offered options, as DSH itself requires, so the card can mark it.
 */
function planReview(
  intent: unknown,
  options: ReadonlyArray<{ label: string }>,
): Pick<CodingQuestion, "intent"> {
  const value = intent as { kind?: unknown; approve?: unknown } | null;
  return value?.kind === "plan-review" &&
    typeof value.approve === "string" &&
    options.some((option) => option.label === value.approve)
    ? { intent: { kind: "plan-review", approve: value.approve } }
    : {};
}
