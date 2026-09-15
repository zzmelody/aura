import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  FlowRun,
  FlowStep,
  FlowCatalog,
  FlowAgentStep,
} from "@aura/protocol/types";
import type { EngineOptions, Table } from "./types.ts";
import type { LoadedFlow } from "./registry.ts";
import type { LoadedAction } from "./action-registry.ts";
import {
  FlowError,
  parse,
  parseJson,
  startSchema,
  jsonValue,
} from "./schema.ts";
import {
  executable,
  fingerprint,
  stepKey,
  StorageFailure,
  terminal,
  validateSaved,
} from "./durable.ts";
import { FlowExecution } from "./execution.ts";
import { FlowScheduler } from "./scheduler.ts";
import { recoverRun } from "./recovery.ts";

const mutationSchema = z
  .object({
    requestId: z.uuid(),
    action: z.enum(["retry", "submit_output", "terminate"]).optional(),
    output: z.unknown().optional(),
  })
  .strict();
type Operation = "pause" | "resume" | "cancel" | "answer" | "resolve";
type Revision = {
  flow: LoadedFlow;
  actions: ReadonlyMap<string, LoadedAction>;
};

/** Public engine facade; durable records own both queue admission and command receipts. */
export class FlowEngine {
  readonly runs: Table<FlowRun>;
  readonly running = new Map<string, FlowExecution>();
  private options: EngineOptions;
  private scheduler: FlowScheduler;
  private revisions = new Map<string, Revision>();
  private operations: Promise<unknown> = Promise.resolve();
  private closed = false;
  private initialized = false;
  private storageFailures = new Set<string>();
  private queueTime() {
    return Math.max(
      Date.now(),
      ...[...this.runs.entries()].map(([, run]) => (run.queuedAt ?? 0) + 1),
    );
  }
  constructor(options: EngineOptions) {
    this.options = options;
    this.runs = options.domain.table("runs");
    this.scheduler = new FlowScheduler(
      () =>
        [...this.runs.entries()]
          .map(([, run]) => run)
          .filter(
            (run) =>
              run.status === "queued" && !this.storageFailures.has(run.id),
          )
          .sort(
            (a, b) =>
              (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
              a.id.localeCompare(b.id),
          )
          .map((run) => run.id),
      (id) => this.execute(id),
    );
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const task = this.operations.then(work);
    this.operations = task.catch(() => undefined);
    return task;
  }
  private async update(id: string, change: (run: FlowRun) => FlowRun) {
    try {
      const run = await this.runs.update(id, (current) => ({
        ...change(current),
        updatedAt: Date.now(),
      }));
      this.scheduler.notify();
      return run;
    } catch {
      this.storageFailures.add(id);
      throw new StorageFailure();
    }
  }
  async initialize() {
    if (this.initialized) return;
    await this.options.refreshFlows();
    for (const [id, run] of this.runs.entries()) {
      if (!executable(run.status)) continue;
      if (run.durableVersion && !(await this.revision(id))) continue;
      const recovered = await recoverRun(run, this.options.sessions);
      await this.update(id, () => recovered);
    }
    this.initialized = true;
    this.scheduler.kick();
  }
  async catalog(): Promise<FlowCatalog> {
    await this.options.refreshFlows();
    return {
      flows: this.options.registry.catalog(),
      actions: this.options.actions?.registry.catalog() ?? [],
      presets: await this.options.presets(),
    };
  }
  list() {
    return [...this.runs.entries()]
      .map(([, run]) => ({
        id: run.id,
        flowId: run.flow.id,
        title: run.flow.title,
        inputPreview:
          JSON.stringify(run.input).length > 140
            ? `${JSON.stringify(run.input).slice(0, 137)}…`
            : JSON.stringify(run.input),
        status: run.status,
        mode: run.mode,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }
  get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new FlowError("Flow 运行不存在。", 404);
    return run;
  }
  start(input: unknown) {
    return this.serialize(async () => {
      if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
      const request = parse(startSchema, input);
      const previous = [...this.runs.entries()].find(
        ([, run]) => run.requestId === request.requestId,
      )?.[1];
      if (previous) {
        if (
          previous.flow.id !== request.flowId ||
          previous.mode !== request.mode ||
          (previous.requestInputHash ?? fingerprint(previous.input)) !==
            fingerprint(jsonValue(request.input, "Flow 入参"))
        )
          throw new FlowError("同一请求 ID 不能用于不同输入。", 409);
        return previous;
      }
      await this.options.refreshFlows();
      const flow = this.options.registry.get(request.flowId);
      const args = parseJson(flow.inputSchema, request.input, "Flow 入参");
      const actions =
        this.options.actions?.registry.snapshot() ??
        new Map<string, LoadedAction>();
      const run: FlowRun = {
        id: randomUUID(),
        requestId: request.requestId,
        flow: {
          id: flow.id,
          title: flow.title,
          description: flow.description,
          sourceHash: flow.sourceHash,
        },
        input: args,
        mode: request.mode,
        status: "queued",
        createdAt: Date.now(),
        queuedAt: this.queueTime(),
        updatedAt: Date.now(),
        steps: [],
        durableVersion: 1,
        requestInputHash: fingerprint(jsonValue(request.input, "Flow 入参")),
        actionVersions: [...actions.values()].map(({ id, sourceHash }) => ({
          id,
          sourceHash,
        })),
      };
      await this.runs.put(run.id, run);
      this.revisions.set(run.id, { flow, actions });
      this.scheduler.kick();
      return run;
    });
  }
  private async revision(
    id: string,
    rejectedCommand?: { requestId: string; fingerprint: string },
  ): Promise<Revision | undefined> {
    const run = this.get(id);
    try {
      const flow = this.options.registry.get(run.flow.id);
      const actions =
        this.options.actions?.registry.snapshot() ??
        new Map<string, LoadedAction>();
      if (flow.sourceHash !== run.flow.sourceHash) throw new Error("Flow");
      for (const step of run.steps) {
        const refs =
          step.kind === "action" && step.sourceHash
            ? [{ id: step.actionId, sourceHash: step.sourceHash }]
            : step.kind === "agent" || step.kind === undefined
              ? (step.actions ?? [])
              : [];
        for (const ref of refs)
          if (actions.get(ref.id)?.sourceHash !== ref.sourceHash)
            throw new Error("Action");
      }
      return { flow, actions };
    } catch {
      await this.update(id, (current) => ({
        ...current,
        status: "interrupted",
        finishedAt: Date.now(),
        error:
          "revision_mismatch: Flow 或已引用 Action 的代码已变化，请新建运行。",
        commands: rejectedCommand
          ? [
              ...(current.commands ?? []),
              { ...rejectedCommand, status: "interrupted", at: Date.now() },
            ]
          : current.commands,
      }));
      return undefined;
    }
  }
  private async execute(id: string) {
    if (this.closed || this.get(id).status !== "queued") return;
    const revision = this.revisions.get(id) ?? (await this.revision(id));
    if (!revision || this.closed || this.get(id).status !== "queued") return;
    this.revisions.delete(id);
    const execution = new FlowExecution({
      ...revision,
      ports: this.options,
      get: () => this.get(id),
      update: (change) => this.update(id, change),
    });
    this.running.set(id, execution);
    try {
      await execution.run();
    } finally {
      this.running.delete(id);
      this.scheduler.notify();
    }
  }
  async wait(id: string) {
    while (executable(this.get(id).status)) {
      if (this.storageFailures.has(id))
        throw new FlowError(
          "Flow 状态存档失败，请修复存储并重启运行时恢复。",
          503,
        );
      if (this.closed) break;
      const changed = this.scheduler.changed();
      this.scheduler.kick();
      await changed;
    }
    return this.get(id);
  }
  async command(
    id: string,
    operation: Operation,
    input: unknown,
    key?: string,
  ) {
    const request = parse(mutationSchema, input);
    if ((operation === "answer" || operation === "resolve") && !key)
      throw new FlowError("缺少 stepKey。");
    if (operation === "resolve" && !request.action)
      throw new FlowError("缺少处理方式。");
    if (request.action && operation !== "resolve")
      throw new FlowError("此操作不接受 action。");
    const bodyHash = fingerprint({ operation, key, ...request });
    const result = await this.serialize(async () => {
      if (this.closed) throw new FlowError("编排服务正在关闭。", 503);
      const current = this.get(id);
      const receipt = current.commands?.find(
        (item) => item.requestId === request.requestId,
      );
      if (receipt) {
        if (receipt.fingerprint !== bodyHash)
          throw new FlowError("同一请求 ID 不能用于不同操作。", 409);
        return current;
      }
      if (terminal(current.status) && operation !== "cancel")
        throw new FlowError("此运行已结束，请新建运行。", 409);
      if (operation === "resume") {
        if (current.status !== "paused")
          throw new FlowError("仅 paused 运行可以恢复。", 409);
        await this.options.refreshFlows();
        if (
          !(await this.revision(id, {
            requestId: request.requestId,
            fingerprint: bodyHash,
          }))
        )
          return this.get(id);
      }
      let next = current;
      if (operation === "pause") {
        if (
          !["queued", "running", "pausing", "paused"].includes(current.status)
        )
          throw new FlowError("当前状态不能暂停。", 409);
        next = {
          ...current,
          status:
            current.status !== "paused" && this.running.has(id)
              ? "pausing"
              : "paused",
        };
      }
      if (operation === "resume")
        next = { ...current, status: "queued", queuedAt: this.queueTime() };
      if (operation === "cancel")
        next = terminal(current.status)
          ? current
          : {
              ...current,
              status: "cancelled",
              finishedAt: Date.now(),
              error: "Flow 已取消。",
            };
      if (operation === "answer" || operation === "resolve") {
        const step = current.steps.find((step) => stepKey(step) === key);
        if (!step) throw new FlowError("Flow 步骤不存在。", 404);
        if (
          operation === "answer" &&
          (current.status !== "waiting_input" ||
            step.kind !== "checkpoint" ||
            step.status !== "waiting_input")
        )
          throw new FlowError("该 checkpoint 当前不等待输入。", 409);
        if (
          operation === "resolve" &&
          (current.status !== "needs_attention" || step.status !== "unknown")
        )
          throw new FlowError("该步骤当前不等待人工处理。", 409);
        let changed: FlowStep = step;
        if (operation === "answer" || request.action === "submit_output") {
          const output =
            step.kind === "agent" || step.kind === undefined
              ? parseJson(
                  z.string().trim().min(1).max(80_000),
                  request.output,
                  "Agent 输出",
                )
              : validateSaved(
                  "outputSchema" in step ? (step.outputSchema ?? {}) : {},
                  request.output,
                );
          changed = {
            ...step,
            status: "completed",
            output,
            finishedAt: Date.now(),
            error: undefined,
          } as FlowStep;
        }
        if (request.action === "retry")
          changed = {
            ...step,
            status: "queued",
            error: undefined,
            nextAttemptAt: undefined,
            extraAttempts: (step.extraAttempts ?? 0) + 1,
          };
        changed = {
          ...changed,
          recoveryEvents: [
            ...(step.recoveryEvents ?? []),
            {
              at: Date.now(),
              requestId: request.requestId,
              ...(request.action ? { action: request.action } : {}),
              reason:
                operation === "answer"
                  ? "已提交 checkpoint 答案。"
                  : `人工处理：${request.action}`,
            },
          ],
        };
        const steps = current.steps.map((item) =>
          stepKey(item) === key ? changed : item,
        );
        next = {
          ...current,
          steps,
          error: undefined,
          status:
            request.action === "terminate"
              ? "cancelled"
              : steps.some((item) => item.status === "unknown")
                ? "needs_attention"
                : "queued",
          queuedAt: this.queueTime(),
          finishedAt: request.action === "terminate" ? Date.now() : undefined,
        };
      }
      // Step completions may interleave with pause/cancel. Preserve their latest records.
      const updated = await this.update(id, (latest) => {
        if (
          (operation === "pause" || operation === "cancel") &&
          terminal(latest.status)
        )
          next = latest;
        return {
          ...latest,
          status: next.status,
          queuedAt: next.queuedAt,
          finishedAt: next.finishedAt,
          error: next.error,
          ...(operation === "answer" || operation === "resolve"
            ? { steps: next.steps }
            : {}),
          commands: [
            ...(latest.commands ?? []),
            {
              requestId: request.requestId,
              fingerprint: bodyHash,
              status: next.status,
              at: Date.now(),
            },
          ],
        };
      });
      if (operation === "pause" && updated.status === "pausing")
        this.running.get(id)?.pause();
      if (operation === "cancel" || request.action === "terminate") {
        const execution = this.running.get(id);
        if (execution) {
          execution.cancelRequested = true;
          execution.abort.abort(new Error("cancelled"));
        } else this.revisions.delete(id);
      }
      this.scheduler.kick();
      return updated;
    });
    if (operation === "cancel")
      await this.scheduler.running.get(id)?.catch(() => undefined);
    return operation === "cancel" ? this.get(id) : result;
  }
  pause(id: string, requestId = randomUUID()) {
    return this.command(id, "pause", { requestId });
  }
  resume(id: string, requestId = randomUUID()) {
    return this.command(id, "resume", { requestId });
  }
  cancel(id: string, requestId = randomUUID()) {
    return this.command(id, "cancel", { requestId });
  }
  async history(
    id: string,
    key: string,
    beforeSeq?: number,
    attemptNumber?: number,
  ) {
    const step = this.get(id).steps.find(
      (candidate) =>
        stepKey(candidate) === key ||
        (!candidate.stepKey && candidate.id === key),
    );
    if (!step) throw new FlowError("Flow 步骤不存在。", 404);
    if (step.kind && step.kind !== "agent")
      throw new FlowError(
        "该步骤没有 DSH session，请读取结构化输入和输出。",
        400,
      );
    let agent = step as FlowAgentStep;
    if (attemptNumber !== undefined) {
      const attempt = step.attempts?.find(
        (value) => value.number === attemptNumber,
      );
      if (!attempt?.sessionId)
        throw new FlowError("Agent attempt 不存在。", 404);
      agent = {
        ...agent,
        sessionId: attempt.sessionId,
        startedAt: attempt.startedAt,
      };
    }
    return this.options.sessions.history(agent, beforeSeq);
  }
  async close() {
    this.closed = true;
    this.scheduler.stop();
    await this.operations;
    for (const execution of this.running.values()) {
      execution.closing = true;
      execution.abort.abort(new Error("runtime closing"));
    }
    await Promise.allSettled([...this.scheduler.running.values()]);
  }
}
