import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  FlowRun,
  FlowStep,
  FlowAgentStep,
  FlowActionStep,
  FlowChildStep,
  FlowAttempt,
  JsonValue,
} from "@aura/protocol/types";
import type { LoadedFlow } from "./registry.ts";
import type { LoadedAction } from "./action-registry.ts";
import type { EngineOptions } from "./types.ts";
import type {
  FlowAgentRequest,
  FlowActionRequest,
  FlowChildRequest,
  FlowScope,
} from "./flow-api.ts";
import {
  actionRequestSchema,
  agentRequestSchema,
  flowRequestSchema,
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
import { agentConfig } from "./agent-config.ts";
import { FLOW_TIMEOUT_MS } from "./timeouts.ts";

interface ExecutionOptions {
  get(): FlowRun;
  update(change: (run: FlowRun) => FlowRun): Promise<FlowRun>;
  report(value: unknown): Promise<void>;
  flow: LoadedFlow;
  actions: ReadonlyMap<string, LoadedAction>;
  ports: Pick<EngineOptions, "sessions" | "presets" | "actions">;
  flows: {
    resolve(
      parentRunId: string,
      flowId: string,
      input: unknown,
    ): Promise<{
      id: string;
      title: string;
      sourceHash: string;
      plugin?: FlowChildStep["plugin"];
      input: JsonValue;
      outputSchema: JsonValue;
    }>;
    start(parentRunId: string, step: FlowChildStep): Promise<FlowRun>;
    run(runId: string): Promise<FlowRun>;
  };
}

function samePlugin(
  left: LoadedAction["plugin"],
  right: LoadedAction["plugin"],
) {
  return (
    left?.id === right?.id &&
    left?.version === right?.version &&
    Boolean(left) === Boolean(right)
  );
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
  expire() {
    this.fatalError = new FlowError(
      `FLOW_TIMEOUT: 工作流执行超过 ${FLOW_TIMEOUT_MS / 60_000} 分钟。`,
    );
    this.abort.abort(this.fatalError);
    this.admissionAbort.abort(this.fatalError);
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
    if (this.visited.size >= (this.options.flow.stepLimit ?? 64))
      throw new FlowError(
        `单次 Flow 最多执行 ${this.options.flow.stepLimit ?? 64} 个 durable 步骤。`,
      );
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
      (!version ||
        version.sourceHash !== action?.sourceHash ||
        !samePlugin(version.plugin, action?.plugin))
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
          let uncertainty: string | undefined;
          if (step.kind === "agent") {
            try {
              const result =
                await this.options.ports.sessions.reconcile?.(step);
              if (result?.output !== undefined)
                return await this.complete(key, result.output);
              unknown = result
                ? result.actionStarted
                : Boolean(step.actions?.length);
              if (unknown)
                uncertainty = result
                  ? "Agent 已调用工具，外部结果需人工确认。"
                  : "无法核对 Agent 的工具执行记录，外部结果需人工确认。";
            } catch {
              unknown = true;
              uncertainty =
                "无法核对 Agent 的工具执行记录，外部结果需人工确认。";
            }
          }
          const failure =
            error instanceof FlowError
              ? error.message
              : step.kind === "agent"
                ? "DSH Agent 执行失败或超时，请查看对应会话。"
                : "Action 执行失败。";
          const message = uncertainty ? `${uncertainty} ${failure}` : failure;
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
    const { model, reasoningEffort, maxTokens, temperature, timeoutMs } =
      request;
    const defaults = this.options.get().agentDefaults;
    if (!defaults)
      throw new ReplayMismatch("运行缺少已存档的 Agent 默认配置。");
    const config = agentConfig(defaults, {
      model,
      reasoningEffort,
      maxTokens,
      temperature,
      timeoutMs,
    });
    const definitions = request.actions.map((id) => this.actionDefinition(id));
    const refs = definitions
      .filter((action): action is LoadedAction => Boolean(action))
      .map(({ id, sourceHash, plugin }) => ({ id, sourceHash, plugin }));
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
        config,
        retry: parse(retrySchema, request.retry ?? {}),
      },
      { ...request, actionVersions: refs, config },
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
      try {
        await this.options.ports.sessions.validateConfig?.(config);
      } catch (error) {
        return this.failed(
          prepared.key,
          error instanceof FlowError
            ? error.message
            : "Agent 模型配置不可用，请检查模型及参数。",
        );
      }
    }
    const step = (await this.perform(prepared.key, async (current) => {
      const output = await this.options.ports.sessions.execute({
        ...(current as FlowAgentStep),
        input: request.prompt,
        ...(request.images ? { images: request.images } : {}),
        mode: this.options.get().mode,
        timeoutMs: (current as FlowAgentStep).config!.timeoutMs,
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
        plugin: action?.plugin,
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
          attempt: current.attempts?.at(-1)?.number,
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
  private flow = async (path: string[], input: FlowChildRequest) => {
    const request = parse(flowRequestSchema, input);
    const rawInput = jsonValue(request.input, "子 Flow 入参");
    const key = [...path, request.id].join("/");
    const existing = this.options
      .get()
      .steps.find((step) => stepKey(step) === key);
    if (existing && existing.kind !== "flow") {
      this.fatalError = new ReplayMismatch(
        `步骤 ${key} 的类型与子 Flow 调用不一致。`,
      );
      throw this.fatalError;
    }
    const pinned = existing as FlowChildStep | undefined;
    if (
      pinned &&
      (pinned.flowId !== request.flow ||
        pinned.requestInputHash !== fingerprint(rawInput))
    ) {
      this.fatalError = new ReplayMismatch(
        `步骤 ${key} 的子 Flow 或输入与存档不一致。`,
      );
      throw this.fatalError;
    }
    const target = pinned
      ? {
          id: pinned.flowId,
          title: pinned.label,
          sourceHash: pinned.sourceHash,
          plugin: pinned.plugin,
          input: pinned.input,
          outputSchema: pinned.outputSchema,
        }
      : await this.options.flows.resolve(
          this.options.get().id,
          request.flow,
          request.input,
        );
    const prepared = await this.prepare(
      path,
      {
        kind: "flow",
        id: request.id,
        label: request.label ?? target.title,
        flowId: target.id,
        sourceHash: target.sourceHash,
        plugin: target.plugin,
        input: target.input,
        outputSchema: target.outputSchema,
        childRequestId: pinned?.childRequestId ?? randomUUID(),
        childRunId: pinned?.childRunId,
        requestInputHash: fingerprint(rawInput),
        status: "queued",
      },
      {
        id: request.id,
        label: request.label,
        flow: target.id,
        sourceHash: target.sourceHash,
        plugin: target.plugin,
        requestInputHash: fingerprint(rawInput),
      },
    );
    if (this.reusable(prepared.step)) {
      const step = prepared.step as FlowChildStep;
      return {
        stepId: prepared.key,
        runId: step.childRunId!,
        flowId: step.flowId,
        output: step.output!,
        recovered: prepared.recovered,
      };
    }
    const release = await this.acquire();
    try {
      let step = prepared.step as FlowChildStep;
      const child = await this.options.flows.start(this.options.get().id, step);
      step = (await this.updateStep(prepared.key, (current) => ({
        ...current,
        childRunId: child.id,
        status: "running",
        startedAt: current.startedAt ?? Date.now(),
        error: undefined,
      }))) as FlowChildStep;
      this.boundary();
      const result = await this.options.flows.run(child.id);
      this.boundary();
      if (result.status === "completed") {
        const completed = (await this.complete(
          prepared.key,
          result.output!,
        )) as FlowChildStep;
        return {
          stepId: prepared.key,
          runId: child.id,
          flowId: completed.flowId,
          output: completed.output!,
          recovered: prepared.recovered,
        };
      }
      if (result.status === "waiting_input") {
        await this.updateStep(prepared.key, (current) => ({
          ...current,
          status: "waiting_input",
        }));
        return this.suspend("waiting_input");
      }
      if (result.status === "needs_attention") {
        await this.updateStep(prepared.key, (current) => ({
          ...current,
          status: "unknown",
        }));
        return this.suspend("needs_attention");
      }
      if (result.status === "paused") {
        await this.updateStep(prepared.key, (current) => ({
          ...current,
          status: "queued",
        }));
        return this.suspend("paused");
      }
      return this.failed(
        prepared.key,
        `子 Flow ${result.flow.id} ${result.status}：${result.error ?? "未返回结果。"}`,
      );
    } finally {
      release();
    }
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
          flow: this.flow,
          memo: this.memo,
          checkpoint: this.checkpoint,
          report: (value) => this.options.report(value),
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
      const timedOut = this.fatalError?.message.startsWith("FLOW_TIMEOUT:");
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
          (status === "cancelled" || timedOut) &&
          ["running", "queued"].includes(step.status)
            ? {
                ...step,
                status: timedOut ? "failed" : "cancelled",
                error: timedOut ? this.fatalError?.message : step.error,
                finishedAt: Date.now(),
                attempts: step.attempts?.map((attempt) =>
                  attempt.status === "running"
                    ? {
                        ...attempt,
                        status: timedOut ? "failed" : "cancelled",
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
