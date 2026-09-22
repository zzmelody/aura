import type { FlowRun, FlowStep, FlowAttempt } from "@aura/protocol/types";
import type { SessionPort } from "./types.ts";
import { attemptsLeft, retryAt } from "./durable.ts";

export async function recoverStep(
  step: FlowStep,
  sessions: SessionPort,
): Promise<FlowStep> {
  if (step.status !== "running") return step;
  const recovered = (
    status: FlowStep["status"],
    reason: string,
    patch: Partial<FlowStep> = {},
  ): FlowStep =>
    ({
      ...step,
      ...patch,
      status,
      error: status === "queued" || status === "completed" ? undefined : reason,
      finishedAt:
        status === "failed" || status === "completed" ? Date.now() : undefined,
      attempts: step.attempts?.map((attempt, i, all) =>
        i === all.length - 1
          ? {
              ...attempt,
              status: (status === "queued"
                ? "interrupted"
                : status) as FlowAttempt["status"],
              finishedAt: Date.now(),
              error: status === "completed" ? undefined : reason,
            }
          : attempt,
      ),
      recoveryEvents: [
        ...(step.recoveryEvents ?? []),
        { at: Date.now(), reason },
      ],
    }) as FlowStep;
  if (step.kind === "memo")
    return recovered("queued", "memo 在提交前中断，将重新计算。");
  if (step.kind === "checkpoint") return { ...step, status: "waiting_input" };
  if (step.kind === "flow")
    return recovered("queued", "子 Flow 调用在提交前中断，将认领原子 Run。", {
      nextAttemptAt: undefined,
    });
  if (step.kind === "action") {
    if (step.recovery !== "idempotent")
      return recovered("unknown", "Action 执行期间中断，外部结果未知。");
  } else {
    try {
      const outcome = await sessions.reconcile?.(step);
      if (!outcome)
        return recovered("unknown", "无法核对 DSH attempt 的持久化事件。");
      if (outcome.output !== undefined)
        return recovered("completed", "从 DSH 已完成回合认领输出。", {
          output: outcome.output,
        });
      if (outcome.actionStarted)
        return recovered(
          "unknown",
          "Agent 已经调用工具，重新执行需要人工确认。",
        );
    } catch {
      return recovered("unknown", "DSH attempt 的持久化事件暂时无法核对。");
    }
  }
  return attemptsLeft(step)
    ? recovered("queued", "中断的 attempt 将在 retry 预算内重试。", {
        nextAttemptAt: retryAt(step),
      })
    : recovered("failed", "中断的 attempt 已耗尽 retry 预算。");
}

export async function recoverRun(
  run: FlowRun,
  sessions: SessionPort,
): Promise<FlowRun> {
  if (
    !run.durableVersion ||
    run.steps.some(
      (step) =>
        !step.stepKey ||
        !step.requestHash ||
        (step.status === "running" &&
          step.kind !== "memo" &&
          step.kind !== "checkpoint" &&
          step.kind !== "flow" &&
          (!step.attempts?.length ||
            (step.kind !== "action" && !step.requestId))),
    )
  ) {
    return {
      ...run,
      status: "interrupted",
      finishedAt: Date.now(),
      error: "legacy_unrecoverable: 旧运行缺少 durable identity，请新建运行。",
      steps: run.steps.map((step) =>
        ["queued", "running"].includes(step.status)
          ? { ...step, status: "interrupted" }
          : step,
      ),
    };
  }
  const steps = await Promise.all(
    run.steps.map((step) => recoverStep(step, sessions)),
  );
  const status = steps.some((step) => step.status === "unknown")
    ? "needs_attention"
    : steps.some((step) => step.status === "waiting_input")
      ? "waiting_input"
      : run.status === "pausing"
        ? "paused"
        : "queued";
  return {
    ...run,
    steps,
    status,
    updatedAt: Date.now(),
    recoveryEvents: [
      ...(run.recoveryEvents ?? []),
      { at: Date.now(), reason: "运行时重新启动，已核对持久化步骤。" },
    ],
  };
}
