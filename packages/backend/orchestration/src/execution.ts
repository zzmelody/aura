import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  FlowRun,
  FlowStep,
  FlowAgentStep,
  FlowActionStep,
  FlowAttempt,
  JsonValue,
} from "@aura/protocol/types";
import type { LoadedFlow } from "./registry.ts";
import type { LoadedAction } from "./action-registry.ts";
import type { EngineOptions } from "./types.ts";
import type {
  FlowAgentRequest,
  FlowActionRequest,
  FlowScope,
} from "./flow-api.ts";
import {
  actionRequestSchema,
  agentRequestSchema,
  FlowError,
  jsonValue,
  parse,
  parseJson,
  retrySchema,
} from "./schema.ts";
import {
  attemptsLeft,
  ConcurrencyGate,
  fingerprint,
  ReplayMismatch,
  retryAt,
  savedSchema,
  stepKey,
  StorageFailure,
  Suspension,
} from "./durable.ts";
import { runScoped } from "./scopes.ts";

interface ExecutionOptions {
  get(): FlowRun;
  update(change: (run: FlowRun) => FlowRun): Promise<FlowRun>;
  flow: LoadedFlow;
  actions: ReadonlyMap<string, LoadedAction>;
  ports: Pick<EngineOptions, "sessions" | "presets" | "actions">;
}

/** One replay segment; only durable operations cross this object's boundary. */
export class FlowExecution {
  readonly abort = new AbortController();
  readonly admissionAbort = new AbortController();
  cancelRequested = false;
  closing = false;
  private suspension?: Suspension;
  private fatalError?: Error;
  private visited = new Set<string>();
  private gate: ConcurrencyGate;
  private options: ExecutionOptions;
  constructor(options: ExecutionOptions) {
    this.options = options;
    this.gate = new ConcurrencyGate(options.flow.concurrency);
  }
  pause() {
    this.suspension = new Suspension("paused");
    this.admissionAbort.abort(this.suspension);
  }
  private suspend(phase: Suspension["phase"]): never {
    this.suspension = new Suspension(phase);
    this.admissionAbort.abort(this.suspension);
    throw this.suspension;
  }
  private boundary = () => {
    if (this.fatalError) throw this.fatalError;
    this.abort.signal.throwIfAborted();
    if (this.suspension) throw this.suspension;
    if (this.options.get().status === "pausing") this.suspend("paused");
  };
  private async updateStep(key: string, change: (step: FlowStep) => FlowStep) {
    const run = await this.options.update((run) => ({
      ...run,
      steps: run.steps.map((step) =>
        stepKey(step) === key ? change(step) : step,
      ),
    }));
    return run.steps.find((step) => stepKey(step) === key)!;
  }
  private step(key: string) {
    return this.options.get().steps.find((step) => stepKey(step) === key)!;
  }
  private async prepare(
    path: string[],
    draft: FlowStep,
    request: unknown,
  ): Promise<{ key: string; step: FlowStep; recovered: boolean }> {
    this.boundary();
    const key = [...path, draft.id].join("/");
    if (this.visited.size >= 64)
      throw new FlowError("单次 Flow 最多执行 64 个 durable 步骤。");
    if (this.visited.has(key))
      throw new FlowError(`Flow 步骤 ID 不能重复：${key}`);
    this.visited.add(key);
    const requestHash = fingerprint({ kind: draft.kind, path, request });
    const existing = this.step(key);
    if (existing) {
      if (
        existing.kind !== draft.kind ||
        existing.requestHash !== requestHash
      ) {
        this.fatalError = new ReplayMismatch(
          `步骤 ${key} 的调用与存档不一致。`,
        );
        throw this.fatalError;
      }
      return { key, step: existing, recovered: true };
    }
    const step = {
      ...draft,
      stepKey: key,
      scopePath: path,
      requestHash,
      attempts: [],
    };
    await this.options.update((run) => ({
      ...run,
      steps: [...run.steps, step],
    }));
    return { key, step, recovered: false };
  }
  private reusable(step: FlowStep) {
    if (step.status === "completed") return true;
    if (step.status === "unknown") this.suspend("needs_attention");
    if (step.status === "waiting_input") this.suspend("waiting_input");
    if (step.status === "failed")
      throw new FlowError(step.error ?? "步骤失败。");
    return false;
  }
  private actionDefinition(id: string) {
    const action = this.options.actions.get(id);
    const version = this.options
      .get()
      .actionVersions?.find((ref) => ref.id === id);
    if (
      (action || version) &&
      (!version || version.sourceHash !== action?.sourceHash)
    ) {
      this.fatalError = new ReplayMismatch(
        `Action ${id} 不再是运行创建时的版本。`,
      );
      throw this.fatalError;
    }
    return action;
  }
  private async failed(key: string, message: string): Promise<never> {
    await this.updateStep(key, (step) => ({
      ...step,
      status: "failed",
      error: message,
      finishedAt: Date.now(),
    }));
    throw new FlowError(message);
  }
  private async acquire() {
    this.boundary();
    const release = await this.gate.acquire(
      AbortSignal.any([this.abort.signal, this.admissionAbort.signal]),
    );
    try {
      this.boundary();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  private async perform(
    key: string,
    execute: (step: FlowStep) => Promise<JsonValue>,
  ): Promise<FlowStep> {
    for (;;) {
      let step = this.step(key);
      if (this.reusable(step)) return step;
      this.boundary();
      if (!attemptsLeft(step))
        return this.failed(key, "步骤已耗尽 retry 预算。");
      if (step.nextAttemptAt && step.nextAttemptAt > Date.now())
        await delay(step.nextAttemptAt - Date.now(), undefined, {
          signal: AbortSignal.any([
            this.abort.signal,
            this.admissionAbort.signal,
          ]),
        });
      const release = await this.acquire();
      try {
        const attempt: FlowAttempt = {
          number: (step.attempts?.length ?? 0) + 1,
          status: "running",
          startedAt: Date.now(),
        };
        if (step.kind === "agent") {
          attempt.sessionId = randomUUID();
          attempt.requestId = randomUUID();
        }
        step = await this.updateStep(
          key,
          (current) =>
            ({
              ...current,
              status: "running",
              error: undefined,
              finishedAt: undefined,
              startedAt: current.startedAt ?? attempt.startedAt,
              nextAttemptAt: undefined,
              ...(current.kind === "agent"
                ? {
                    sessionId: attempt.sessionId!,
                    requestId: attempt.requestId!,
                  }
                : {}),
              attempts: [...(current.attempts ?? []), attempt],
            }) as FlowStep,
        );
        let output: JsonValue;
        try {
          output = await execute(step);
        } catch (error) {
          if (error instanceof StorageFailure) throw error;
          if (this.closing) throw error;
          if (this.abort.signal.aborted) throw error;
          let unknown =
            step.kind === "action" &&
            error instanceof FlowError &&
            /TOOL_OUTCOME_UNKNOWN/.test(error.message);
          if (step.kind === "agent") {
            try {
              const result =
                await this.options.ports.sessions.reconcile?.(step);
              if (result?.output !== undefined)
                return await this.complete(key, result.output);
              unknown = result
                ? result.actionStarted
                : Boolean(step.actions?.length);
            } catch {
              unknown = true;
            }
          }
          const message =
            error instanceof FlowError
              ? error.message
              : step.kind === "agent"
                ? "DSH Agent 执行失败或超时，请查看对应会话。"
                : "Action 执行失败。";
          const retry = !unknown && attemptsLeft(step);
          await this.updateStep(key, (current) => ({
            ...current,
            status: unknown ? "unknown" : retry ? "queued" : "failed",
            error: message,
            finishedAt: retry || unknown ? undefined : Date.now(),
            nextAttemptAt: retry ? retryAt(current) : undefined,
            attempts: current.attempts!.map((value, i, all) =>
              i === all.length - 1
                ? {
                    ...value,
                    status: unknown ? "unknown" : "failed",
                    finishedAt: Date.now(),
                    error: message,
                  }
                : value,
            ),
          }));
          if (unknown) this.suspend("needs_attention");
          if (!retry) throw new FlowError(message);
          continue;
        }
        // Never turn an output-commit failure into an automatic effect retry.
        return await this.complete(key, output);
      } finally {
        release();
      }
    }
  }
  private complete(key: string, output: JsonValue) {
    return this.updateStep(
      key,
      (step) =>
        ({
          ...step,
          status: "completed",
          output,
          error: undefined,
          finishedAt: Date.now(),
          attempts: step.attempts?.map((attempt, i, all) =>
            i === all.length - 1
              ? {
                  ...attempt,
                  status: "completed",
                  finishedAt: Date.now(),
                  error: undefined,
                }
              : attempt,
          ),
        }) as FlowStep,
    );
  }
  private agent = async (path: string[], input: FlowAgentRequest) => {
    const request = parse(agentRequestSchema, input);
    const definitions = request.actions.map((id) => this.actionDefinition(id));
    const refs = definitions
      .filter((action): action is LoadedAction => Boolean(action))
      .map(({ id, sourceHash }) => ({ id, sourceHash }));
    const prepared = await this.prepare(
      path,
      {
        kind: "agent",
        id: request.id,
        label: request.label,
        preset: request.preset,
        sessionId: randomUUID(),
        status: "queued",
        actions: refs,
        retry: parse(retrySchema, request.retry ?? {}),
      },
      { ...request, actionVersions: refs },
    );
    if (!this.reusable(prepared.step)) {
      if (
        definitions.some((action) => !action) ||
        new Set(request.actions).size !== request.actions.length
      )
        return this.failed(
          prepared.key,
          "Agent Action 不存在或 actions 重复。",
        );
      const preset = (await this.options.ports.presets()).find(
        (item) => item.id === request.preset,
      );
      if (!preset || preset.unavailable)
        return this.failed(
          prepared.key,
          `Preset 不存在或不可用：${request.preset}`,
        );
    }
    const step = (await this.perform(prepared.key, async (current) => {
      const output = await this.options.ports.sessions.execute({
        ...(current as FlowAgentStep),
        input: request.prompt,
        mode: this.options.get().mode,
        timeoutMs: this.options.flow.agentTimeoutMs,
        signal: this.abort.signal,
        runId: this.options.get().id,
        actionDefinitions: definitions as LoadedAction[],
      });
      if (!output.trim() || output.length > 80_000)
        throw new FlowError("Agent 输出为空或超过 80,000 字符限制。");
      return output;
    })) as FlowAgentStep;
    return {
      stepId: prepared.key,
      sessionId: step.sessionId,
      output: step.output!,
      attempt: step.attempts?.length,
      recovered: prepared.recovered,
    };
  };
  private action = async (path: string[], input: FlowActionRequest) => {
    const request = parse(actionRequestSchema, input);
    const action = this.actionDefinition(request.action);
    const args = jsonValue(request.input, "Action 入参");
    const prepared = await this.prepare(
      path,
      {
        kind: "action",
        id: request.id,
        label: request.label ?? action?.title ?? request.action,
        actionId: request.action,
        sourceHash: action?.sourceHash,
        input: args,
        status: "queued",
        recovery: action?.recovery ?? "manual",
        retry: parse(retrySchema, request.retry ?? {}),
        outputSchema: action?.outputSchema,
        idempotencyKey: randomUUID(),
      },
      { ...request, input: args, sourceHash: action?.sourceHash },
    );
    if (!this.reusable(prepared.step)) {
      if (!action || !this.options.ports.actions)
        return this.failed(
          prepared.key,
          `Action 不存在或不可用：${request.action}`,
        );
      if (
        action.recovery !== "idempotent" &&
        (request.retry?.maxAttempts ?? 1) > 1
      )
        return this.failed(
          prepared.key,
          "只有声明 recovery: idempotent 的 Action 可以自动重试。",
        );
    }
    const step = (await this.perform(prepared.key, async (current) =>
      this.options.ports.actions!.runtime.execute(
        action!,
        args,
        {
          cwd: this.options.ports.actions!.cwd,
          mode: this.options.get().mode,
          runId: this.options.get().id,
          stepId: prepared.key,
          idempotencyKey: (current as FlowActionStep).idempotencyKey,
        },
        this.abort.signal,
      ),
    )) as FlowActionStep;
    return {
      stepId: prepared.key,
      actionId: step.actionId,
      output: step.output!,
      attempt: step.attempts?.length,
      recovered: prepared.recovered,
    };
  };
  private memo = async (
    path: string[],
    request: Parameters<FlowScope["memo"]>[0],
  ) => {
    const outputSchema = savedSchema(request.schema);
    const prepared = await this.prepare(
      path,
      {
        kind: "memo",
        id: request.id,
        label: request.label ?? request.id,
        status: "queued",
        outputSchema,
      },
      { id: request.id, outputSchema },
    );
    if (this.reusable(prepared.step)) return prepared.step.output;
    const release = await this.acquire();
    try {
      await this.updateStep(prepared.key, (step) => ({
        ...step,
        status: "running",
        startedAt: Date.now(),
      }));
      let output: JsonValue;
      try {
        output = parseJson(
          request.schema,
          await request.compute(),
          "memo 输出",
        );
      } catch (error) {
        if (this.closing) throw error;
        return this.failed(
          prepared.key,
          error instanceof FlowError ? error.message : "memo 计算失败。",
        );
      }
      return (await this.complete(prepared.key, output)).output;
    } finally {
      release();
    }
  };
  private checkpoint = async (
    path: string[],
    request: Parameters<FlowScope["checkpoint"]>[0],
  ) => {
    const outputSchema = savedSchema(request.schema);
    const prepared = await this.prepare(
      path,
      {
        kind: "checkpoint",
        id: request.id,
        label: request.label ?? request.id,
        status: "waiting_input",
        prompt: request.prompt,
        outputSchema,
      },
      { id: request.id, prompt: request.prompt, outputSchema },
    );
    if (prepared.step.status === "completed") return prepared.step.output;
    return this.suspend("waiting_input");
  };
  async run() {
    try {
      await this.options.update((run) => ({
        ...run,
        status: run.status === "pausing" ? "pausing" : "running",
        error: undefined,
      }));
      const output = await runScoped(
        {
          context: {
            runId: this.options.get().id,
            mode: this.options.get().mode,
            signal: this.abort.signal,
          },
          boundary: this.boundary,
          fatal: (error) => {
            this.fatalError = error;
          },
          agent: this.agent,
          action: this.action,
          memo: this.memo,
          checkpoint: this.checkpoint,
        },
        (context) => this.options.flow.run(context, this.options.get().input),
      );
      this.boundary();
      const missing = this.options
        .get()
        .steps.find((step) => !this.visited.has(stepKey(step)));
      if (missing)
        throw new ReplayMismatch(`历史步骤 ${stepKey(missing)} 未被重放访问。`);
      const value = parseJson(
        this.options.flow.outputSchema,
        output,
        "Flow 出参",
      );
      await this.options.update((run) =>
        run.status === "cancelled"
          ? run
          : run.status === "pausing"
            ? { ...run, status: "paused" }
            : {
                ...run,
                output: value,
                status: "completed",
                finishedAt: Date.now(),
              },
      );
    } catch (cause) {
      const error = this.fatalError ?? cause;
      if (cause instanceof StorageFailure) throw cause;
      if (this.closing) return; // Leave active durable attempts for the next host's reconciliation.
      const run = this.options.get();
      const suspension =
        this.suspension ?? (error instanceof Suspension ? error : undefined);
      const status = this.cancelRequested
        ? "cancelled"
        : error instanceof ReplayMismatch
          ? "interrupted"
          : this.fatalError
            ? "failed"
            : run.steps.some((step) => step.status === "unknown")
              ? "needs_attention"
              : (suspension?.phase ?? "failed");
      await this.options.update((current) => ({
        ...current,
        status,
        finishedAt: [
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(status)
          ? Date.now()
          : undefined,
        error:
          status === "cancelled"
            ? "Flow 已取消。"
            : status === "failed" || status === "interrupted"
              ? error instanceof FlowError
                ? error.message
                : "Flow 代码执行失败，请检查后端日志。"
              : undefined,
        steps: current.steps.map((step) =>
          status === "cancelled" && ["running", "queued"].includes(step.status)
            ? {
                ...step,
                status: "cancelled",
                finishedAt: Date.now(),
                attempts: step.attempts?.map((attempt) =>
                  attempt.status === "running"
                    ? {
                        ...attempt,
                        status: "cancelled",
                        finishedAt: Date.now(),
                      }
                    : attempt,
                ),
              }
            : step,
        ),
      }));
    }
  }
}
